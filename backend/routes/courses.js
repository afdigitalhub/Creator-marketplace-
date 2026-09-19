const express = require("express");
const crypto = require("crypto");
const pool = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function makeToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function visitorKey(req) {
  const raw = `${req.ip || "unknown"}|${req.get("user-agent") || "unknown"}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 64);
}

async function getCourse(courseId) {
  const result = await pool.query(
    `SELECT c.*, p.title AS product_title, p.seller_id, p.price, p.currency,
            p.cover_url, p.preview_url, p.affiliate_commission_percent,
            p.status AS product_status, u.full_name AS creator_name
       FROM courses c
       JOIN products p ON p.id = c.product_id
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1`,
    [courseId]
  );
  return result.rows[0] || null;
}

async function getEnrollment(userId, course) {
  if (!userId || !course) return null;

  const result = await pool.query(
    `SELECT ce.*
       FROM course_enrollments ce
      WHERE ce.user_id = $1 AND ce.course_id = $2
      LIMIT 1`,
    [userId, course.id]
  );

  return result.rows[0] || null;
}

async function ensureEnrollment(userId, course) {
  const existing = await getEnrollment(userId, course);
  if (existing) return existing;

  const entitlement = await pool.query(
    `SELECT e.id, e.order_id
       FROM entitlements e
      WHERE e.user_id = $1
        AND e.product_id = $2
        AND e.status = 'active'
      ORDER BY e.id DESC
      LIMIT 1`,
    [userId, course.product_id]
  );

  if (entitlement.rows.length === 0) return null;

  const inserted = await pool.query(
    `INSERT INTO course_enrollments
       (course_id, user_id, product_id, order_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (course_id, user_id)
     DO UPDATE SET
       status = 'active',
       order_id = COALESCE(course_enrollments.order_id, EXCLUDED.order_id),
       updated_at = now()
     RETURNING *`,
    [
      course.id,
      userId,
      course.product_id,
      entitlement.rows[0].order_id
    ]
  );

  return inserted.rows[0];
}

async function courseStructure(courseId, includeContent, userId) {
  const course = await getCourse(courseId);
  if (!course) return null;

  const modulesResult = await pool.query(
    `SELECT cm.id, cm.title, cm.description, cm.position,
            COUNT(cl.id)::int AS lesson_count
       FROM course_modules cm
       LEFT JOIN course_lessons cl ON cl.module_id = cm.id
      WHERE cm.course_id = $1
      GROUP BY cm.id
      ORDER BY cm.position ASC`,
    [courseId]
  );

  const lessonsResult = await pool.query(
    `SELECT cl.id, cl.module_id, cl.title, cl.slug,
            cl.lesson_type, cl.duration_minutes, cl.position, cl.is_preview
            ${includeContent ? ", cl.content" : ""}
       FROM course_lessons cl
       JOIN course_modules cm ON cm.id = cl.module_id
      WHERE cm.course_id = $1
      ORDER BY cm.position ASC, cl.position ASC`,
    [courseId]
  );

  const progress = userId
    ? await pool.query(
        `SELECT clp.lesson_id, clp.completed, clp.completed_at, clp.last_position
           FROM course_lesson_progress clp
           JOIN course_enrollments ce ON ce.id = clp.enrollment_id
          WHERE ce.user_id = $1
            AND ce.course_id = $2`,
        [userId, courseId]
      )
    : { rows: [] };

  const progressMap = new Map(
    progress.rows.map(row => [String(row.lesson_id), row])
  );

  const totalLessons = lessonsResult.rows.length;

  const completedLessons = lessonsResult.rows.filter(
    lesson => progressMap.get(String(lesson.id))?.completed
  ).length;

  const modules = modulesResult.rows.map(module => ({
    ...module,
    lessons: lessonsResult.rows
      .filter(lesson => lesson.module_id === module.id)
      .map(lesson => ({
        ...lesson,
        progress: progressMap.get(String(lesson.id)) || null
      }))
  }));

  return {
    course: {
      ...course,
      affiliate_commission_percent:
        Number(course.affiliate_commission_percent || 50),
      total_lessons: totalLessons,
      completed_lessons: completedLessons,
      completion_percent: totalLessons
        ? Math.round((completedLessons / totalLessons) * 100)
        : 0
    },
    modules
  };
}


/* =========================================================
   PUBLIC COURSES
========================================================= */

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.product_id, c.title, c.slug,
              c.short_description, c.level, c.estimated_hours,
              c.status,
              p.price, p.currency, p.cover_url,
              p.affiliate_commission_percent,
              p.seller_id,
              COUNT(cl.id)::int AS lesson_count
         FROM courses c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN course_modules cm ON cm.course_id = c.id
         LEFT JOIN course_lessons cl ON cl.module_id = cm.id
        WHERE c.status = 'published'
          AND p.status = 'published'
        GROUP BY c.id, p.id
        ORDER BY c.created_at DESC`
    );

    res.json({ courses: result.rows });
  } catch (err) {
    console.error("List courses error:", err);
    res.status(500).json({ error: "Could not load courses" });
  }
});


/* =========================================================
   AFFILIATE STATS
   IMPORTANT: must come BEFORE /:id
========================================================= */

router.get("/affiliate/stats", requireAuth, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(cal.click_count), 0)::int AS link_clicks,
         COUNT(DISTINCT cal.course_id)::int AS courses_promoted
       FROM course_affiliate_links cal
      WHERE cal.user_id = $1
        AND cal.active = true`,
      [req.user.id]
    );

    const sales = await pool.query(
      `SELECT
         COUNT(*)::int AS successful_sales,
         COALESCE(SUM(o.affiliate_amount), 0) AS commission_from_orders
       FROM orders o
       JOIN courses c ON c.product_id = o.product_id
      WHERE o.referrer_id = $1
        AND o.status = 'paid'`,
      [req.user.id]
    );

    const earnings = await pool.query(
      `SELECT
         COALESCE(
           SUM(
             CASE
               WHEN e.status = 'pending' THEN e.net_amount
               ELSE 0
             END
           ), 0
         ) AS pending_commission,

         COALESCE(
           SUM(
             CASE
               WHEN e.status = 'available' THEN e.net_amount
               ELSE 0
             END
           ), 0
         ) AS available_commission,

         COALESCE(
           SUM(
             CASE
               WHEN e.status IN ('pending','available','withdrawn')
               THEN e.net_amount
               ELSE 0
             END
           ), 0
         ) AS total_commission
       FROM earnings e
      WHERE e.user_id = $1
        AND e.source_type = 'affiliate_commission'`,
      [req.user.id]
    );

    const topCourse = await pool.query(
      `SELECT
         c.id,
         c.title,
         COUNT(o.id)::int AS sales,
         COALESCE(SUM(o.affiliate_amount), 0) AS commission
       FROM orders o
       JOIN courses c ON c.product_id = o.product_id
      WHERE o.referrer_id = $1
        AND o.status = 'paid'
      GROUP BY c.id, c.title
      ORDER BY commission DESC, sales DESC
      LIMIT 1`,
      [req.user.id]
    );

    res.json({
      stats: {
        link_clicks: Number(totals.rows[0].link_clicks || 0),
        courses_promoted: Number(
          totals.rows[0].courses_promoted || 0
        ),
        successful_sales: Number(
          sales.rows[0].successful_sales || 0
        ),
        commission_earned: Number(
          earnings.rows[0].total_commission || 0
        ),
        pending_commission: Number(
          earnings.rows[0].pending_commission || 0
        ),
        available_commission: Number(
          earnings.rows[0].available_commission || 0
        ),
        top_course: topCourse.rows[0] || null
      }
    });
  } catch (err) {
    console.error("Affiliate stats error:", err);
    res.status(500).json({
      error: "Could not load affiliate performance"
    });
  }
});


/* =========================================================
   AFFILIATE LINK RESOLUTION
========================================================= */

router.get("/affiliate/resolve/:token", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         cal.id AS affiliate_link_id,
         cal.user_id,
         cal.course_id,
         c.product_id,
         c.title,
         c.status
       FROM course_affiliate_links cal
       JOIN courses c ON c.id = cal.course_id
      WHERE cal.token = $1
        AND cal.active = true`,
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Affiliate link not found"
      });
    }

    const link = result.rows[0];

    if (link.status !== "published") {
      return res.status(404).json({
        error: "Course is not available"
      });
    }

    await pool.query(
      `INSERT INTO course_affiliate_clicks
        (affiliate_link_id, course_id, user_id, visitor_key)
       VALUES ($1, $2, $3, $4)`,
      [
        link.affiliate_link_id,
        link.course_id,
        null,
        visitorKey(req)
      ]
    );

    await pool.query(
      `UPDATE course_affiliate_links
          SET click_count = click_count + 1,
              last_used_at = now()
        WHERE id = $1`,
      [link.affiliate_link_id]
    );

    res.json({
      course_id: link.course_id,
      product_id: link.product_id,
      referrer_id: link.user_id
    });
  } catch (err) {
    console.error("Resolve affiliate link error:", err);
    res.status(500).json({
      error: "Could not resolve affiliate link"
    });
  }
});


/* =========================================================
   CREATE AFFILIATE LINK
========================================================= */

router.post("/:id(\\d+)/affiliate-link", requireAuth, async (req, res) => {
  try {
    const course = await getCourse(req.params.id);

    if (
      !course ||
      course.status !== "published" ||
      course.product_status !== "published"
    ) {
      return res.status(404).json({
        error: "Course not found"
      });
    }

    const existing = await pool.query(
      `SELECT token, click_count, created_at
         FROM course_affiliate_links
        WHERE user_id = $1
          AND course_id = $2
          AND active = true
        LIMIT 1`,
      [req.user.id, course.id]
    );

    let link = existing.rows[0];

    if (!link) {
      const token = makeToken();

      const inserted = await pool.query(
        `INSERT INTO course_affiliate_links
          (user_id, course_id, token)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, course_id)
         DO UPDATE SET active = true
         RETURNING token, click_count, created_at`,
        [req.user.id, course.id, token]
      );

      link = inserted.rows[0];
    }

    const origin =
      process.env.PUBLIC_APP_URL ||
      "https://afdigitalhub.net";

    const affiliate_url =
      `${origin}/course-details.html?id=${encodeURIComponent(course.id)}` +
      `&ref=${encodeURIComponent(link.token)}`;

    res.json({
      affiliate_url,
      token: link.token,
      commission_percent:
        Number(course.affiliate_commission_percent || 50),
      click_count: Number(link.click_count || 0)
    });
  } catch (err) {
    console.error("Create affiliate link error:", err);
    res.status(500).json({
      error: "Could not create affiliate link"
    });
  }
});


/* =========================================================
   COURSE DETAIL
========================================================= */

router.get("/:id(\\d+)", async (req, res) => {
  try {
    const course = await getCourse(req.params.id);

    if (
      !course ||
      course.status !== "published" ||
      course.product_status !== "published"
    ) {
      return res.status(404).json({
        error: "Course not found"
      });
    }

    const structure = await courseStructure(
      course.id,
      false,
      null
    );

    res.json(structure);
  } catch (err) {
    console.error("Get course error:", err);
    res.status(500).json({
      error: "Could not load course"
    });
  }
});


/* =========================================================
   COURSE ACCESS
========================================================= */

router.get("/:id(\\d+)/access", requireAuth, async (req, res) => {
  try {
    const course = await getCourse(req.params.id);

    if (!course || course.status !== "published") {
      return res.status(404).json({
        error: "Course not found"
      });
    }

    const enrollment = await ensureEnrollment(
      req.user.id,
      course
    );

    if (!enrollment) {
      return res.json({
        has_access: false,
        enrollment: null
      });
    }

    const structure = await courseStructure(
      course.id,
      false,
      req.user.id
    );

    res.json({
      has_access: true,
      enrollment,
      progress: structure.course.completion_percent
    });
  } catch (err) {
    console.error("Course access error:", err);
    res.status(500).json({
      error: "Could not check course access"
    });
  }
});


/* =========================================================
   LEARNING AREA
========================================================= */

router.get("/:id(\\d+)/learn", requireAuth, async (req, res) => {
  try {
    const course = await getCourse(req.params.id);

    if (!course || course.status !== "published") {
      return res.status(404).json({
        error: "Course not found"
      });
    }

    const enrollment = await ensureEnrollment(
      req.user.id,
      course
    );

    if (!enrollment) {
      return res.status(403).json({
        error: "Purchase this course to access the lessons"
      });
    }

    const structure = await courseStructure(
      course.id,
      true,
      req.user.id
    );

    res.json({
      ...structure,
      enrollment
    });
  } catch (err) {
    console.error("Load course learning error:", err);
    res.status(500).json({
      error: "Could not load course lessons"
    });
  }
});


/* =========================================================
   INDIVIDUAL LESSON
========================================================= */

router.get(
  "/:id(\\d+)/lessons/:lessonId(\\d+)",
  requireAuth,
  async (req, res) => {
    try {
      const course = await getCourse(req.params.id);

      if (!course || course.status !== "published") {
        return res.status(404).json({
          error: "Course not found"
        });
      }

      const enrollment = await ensureEnrollment(
        req.user.id,
        course
      );

      if (!enrollment) {
        return res.status(403).json({
          error: "You do not have access to this course"
        });
      }

      const result = await pool.query(
        `SELECT
           cl.*,
           cm.title AS module_title,
           cm.position AS module_position
         FROM course_lessons cl
         JOIN course_modules cm
           ON cm.id = cl.module_id
        WHERE cl.id = $1
          AND cm.course_id = $2`,
        [req.params.lessonId, course.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Lesson not found"
        });
      }

      res.json({
        lesson: result.rows[0]
      });
    } catch (err) {
      console.error("Get lesson error:", err);
      res.status(500).json({
        error: "Could not load lesson"
      });
    }
  }
);


/* =========================================================
   LESSON PROGRESS
========================================================= */

router.post(
  "/:id(\\d+)/lessons/:lessonId(\\d+)/progress",
  requireAuth,
  async (req, res) => {
    const completed = Boolean(req.body?.completed);

    const lastPosition = Math.max(
      0,
      Math.min(
        1000000,
        Number(req.body?.last_position || 0)
      )
    );

    try {
      const course = await getCourse(req.params.id);

      if (!course || course.status !== "published") {
        return res.status(404).json({
          error: "Course not found"
        });
      }

      const enrollment = await ensureEnrollment(
        req.user.id,
        course
      );

      if (!enrollment) {
        return res.status(403).json({
          error: "You do not have access to this course"
        });
      }

      const lesson = await pool.query(
        `SELECT cl.id
           FROM course_lessons cl
           JOIN course_modules cm
             ON cm.id = cl.module_id
          WHERE cl.id = $1
            AND cm.course_id = $2`,
        [req.params.lessonId, course.id]
      );

      if (lesson.rows.length === 0) {
        return res.status(404).json({
          error: "Lesson not found"
        });
      }

      await pool.query(
        `INSERT INTO course_lesson_progress
          (
            enrollment_id,
            lesson_id,
            user_id,
            completed,
            completed_at,
            last_position
          )
         VALUES
          (
            $1,
            $2,
            $3,
            $4,
            CASE
              WHEN $4 THEN now()
              ELSE NULL
            END,
            $5
          )
         ON CONFLICT (enrollment_id, lesson_id)
         DO UPDATE SET
           completed = EXCLUDED.completed,
           completed_at =
             CASE
               WHEN EXCLUDED.completed
               THEN COALESCE(
                 course_lesson_progress.completed_at,
                 now()
               )
               ELSE NULL
             END,
           last_position = EXCLUDED.last_position,
           updated_at = now()`,
        [
          enrollment.id,
          lesson.rows[0].id,
          req.user.id,
          completed,
          lastPosition
        ]
      );

      const totals = await pool.query(
        `SELECT
           COUNT(*)::int AS total_lessons,
           COUNT(*) FILTER (
             WHERE clp.completed = true
           )::int AS completed_lessons
         FROM course_lessons cl
         JOIN course_modules cm
           ON cm.id = cl.module_id
         LEFT JOIN course_lesson_progress clp
           ON clp.lesson_id = cl.id
          AND clp.enrollment_id = $1
        WHERE cm.course_id = $2`,
        [enrollment.id, course.id]
      );

      const total = Number(
        totals.rows[0].total_lessons || 0
      );

      const done = Number(
        totals.rows[0].completed_lessons || 0
      );

      const percent = total
        ? Math.round((done / total) * 100)
        : 0;

      const status =
        total > 0 && done === total
          ? "completed"
          : "active";

      await pool.query(
        `UPDATE course_enrollments
            SET status = $1,
                completed_at =
                  CASE
                    WHEN $1 = 'completed'
                    THEN COALESCE(completed_at, now())
                    ELSE NULL
                  END,
                updated_at = now()
          WHERE id = $2`,
        [status, enrollment.id]
      );

      res.json({
        lesson_id: lesson.rows[0].id,
        completed,
        total_lessons: total,
        completed_lessons: done,
        completion_percent: percent,
        course_completed:
          status === "completed"
      });
    } catch (err) {
      console.error(
        "Save lesson progress error:",
        err
      );

      res.status(500).json({
        error: "Could not save lesson progress"
      });
    }
  }
);


/* =========================================================
   MY LEARNING
========================================================= */

router.get("/mine/learning", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.title,
         c.slug,
         c.level,
         c.estimated_hours,
         p.cover_url,
         p.price,
         p.currency,
         ce.id AS enrollment_id,
         ce.status,
         ce.enrolled_at,
         ce.completed_at,
         COUNT(cl.id)::int AS total_lessons,
         COUNT(clp.id) FILTER (
           WHERE clp.completed = true
         )::int AS completed_lessons
       FROM course_enrollments ce
       JOIN courses c ON c.id = ce.course_id
       JOIN products p ON p.id = c.product_id
       LEFT JOIN course_modules cm
         ON cm.course_id = c.id
       LEFT JOIN course_lessons cl
         ON cl.module_id = cm.id
       LEFT JOIN course_lesson_progress clp
         ON clp.lesson_id = cl.id
        AND clp.enrollment_id = ce.id
      WHERE ce.user_id = $1
      GROUP BY c.id, p.id, ce.id
      ORDER BY ce.updated_at DESC`,
      [req.user.id]
    );

    const courses = result.rows.map(row => ({
      ...row,
      total_lessons: Number(
        row.total_lessons || 0
      ),
      completed_lessons: Number(
        row.completed_lessons || 0
      ),
      completion_percent:
        Number(row.total_lessons)
          ? Math.round(
              (
                Number(row.completed_lessons) /
                Number(row.total_lessons)
              ) * 100
            )
          : 0
    }));

    res.json({ courses });
  } catch (err) {
    console.error(
      "Load my learning error:",
      err
    );

    res.status(500).json({
      error: "Could not load your courses"
    });
  }
});


/* =========================================================
   ADMIN COURSE INVENTORY
========================================================= */

router.get(
  "/admin/all",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           c.*,
           p.title AS product_title,
           p.price,
           p.currency,
           COUNT(DISTINCT cm.id)::int AS module_count,
           COUNT(DISTINCT cl.id)::int AS lesson_count
         FROM courses c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN course_modules cm
           ON cm.course_id = c.id
         LEFT JOIN course_lessons cl
           ON cl.module_id = cm.id
        GROUP BY c.id, p.id
        ORDER BY c.created_at DESC`
      );

      res.json({
        courses: result.rows
      });
    } catch (err) {
      console.error(
        "Admin course list error:",
        err
      );

      res.status(500).json({
        error: "Could not load course inventory"
      });
    }
  }
);


module.exports = router;
