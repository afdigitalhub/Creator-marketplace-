const pool = require("./config/db");

const COURSES = [
  {
    title: "Personal Finance: Take Control of Your Money",
    subtitle: "Build practical money habits, budgeting skills, and a clearer financial plan.",
    description: "A beginner-friendly practical course on budgeting, saving, spending decisions, financial goals, and building healthier money habits."
  },
  {
    title: "Digital Marketing: Build, Promote & Grow Online",
    subtitle: "Learn the fundamentals of building an online presence and promoting digital offers.",
    description: "A practical beginner course covering digital marketing fundamentals, content, social media, audience building, offers, basic analytics, and sustainable online growth."
  },
  {
    title: "Freelancing: From Your First Skill to Your First Client",
    subtitle: "Turn a useful skill into a professional freelance service.",
    description: "A beginner-friendly roadmap for choosing a service, building proof of skill, finding prospects, communicating professionally, pricing work, and winning a first client."
  },
  {
    title: "Content Creation: Turn Ideas Into Content People Notice",
    subtitle: "Develop a repeatable system for creating useful, engaging content.",
    description: "Learn how to turn ideas into clear content, choose formats, write stronger hooks, create consistently, understand your audience, and improve content using real feedback."
  },
  {
    title: "Affiliate Marketing: Build a Real Promotion System",
    subtitle: "Learn how to promote legitimate offers and build an affiliate workflow.",
    description: "A practical introduction to affiliate marketing covering offer selection, audience research, content, promotion, tracking, ethical marketing, and understanding verified commissions."
  }
];

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const admin = await client.query(`
      SELECT id, full_name
      FROM users
      WHERE role = 'admin'
      ORDER BY id
      LIMIT 1
    `);

    if (!admin.rows.length) {
      throw new Error("No admin account found.");
    }

    const sellerId = admin.rows[0].id;

    for (const course of COURSES) {
      const existing = await client.query(
        `SELECT id FROM products
         WHERE seller_id = $1
         AND LOWER(title) = LOWER($2)
         LIMIT 1`,
        [sellerId, course.title]
      );

      if (existing.rows.length) {
        console.log(`Already exists: ${course.title}`);
        continue;
      }

      await client.query(
        `INSERT INTO products
        (seller_id, title, subtitle, description, category,
         cover_url, preview_url, file_url, price, currency, status)
        VALUES
        ($1,$2,$3,$4,'Courses',
         NULL,NULL,NULL,100,'GHS','published')`,
        [
          sellerId,
          course.title,
          course.subtitle,
          course.description
        ]
      );

      console.log(`Created: ${course.title}`);
    }

    await client.query("COMMIT");
    console.log("✅ 5 AF Digital Hub course products processed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Course seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
