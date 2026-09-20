const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const crypto = require("crypto");

const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_BASE = "https://api.paystack.co";

const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM_EMAIL = (process.env.RESEND_FROM_EMAIL || "").trim();

const PUBLIC_APP_URL = (
  process.env.PUBLIC_APP_URL ||
  "https://afdigitalhub.net"
).replace(/\/+$/, "");

function toMinorUnit(amount) {
  return Math.round(Number(amount) * 100);
}

/* =========================================================
   COURSE ACCESS EMAIL
========================================================= */

async function sendCourseAccessEmail({
  email,
  fullName,
  courseTitle,
  courseId,
  paymentReference
}) {
  if (!email) {
    console.error(
      "Course access email skipped: user email is missing."
    );

    return {
      ok: false,
      skipped: true,
      reason: "missing_email"
    };
  }

  if (!RESEND_API_KEY) {
    console.error(
      "Course access email skipped: RESEND_API_KEY is not configured."
    );

    return {
      ok: false,
      skipped: true,
      reason: "missing_resend_api_key"
    };
  }

  if (!RESEND_FROM_EMAIL) {
    console.error(
      "Course access email skipped: RESEND_FROM_EMAIL is not configured."
    );

    return {
      ok: false,
      skipped: true,
      reason: "missing_resend_from_email"
    };
  }

  if (!courseId) {
    console.error(
      "Course access email skipped: course ID is missing."
    );

    return {
      ok: false,
      skipped: true,
      reason: "missing_course_id"
    };
  }

  const courseUrl =
    `${PUBLIC_APP_URL}/course-learn.html?id=` +
    encodeURIComponent(courseId);

  /*
   * Existing AF Digital Hub sign-in page.
   * The redirect parameter sends the customer to the dashboard
   * after successful login.
   */
  const dashboardUrl =
    `${PUBLIC_APP_URL}/signin.html?redirect=` +
    encodeURIComponent("dashboard.html");

  const safeName =
    fullName ||
    "there";

  const safeCourseTitle =
    courseTitle ||
    "Your AF Digital Hub Course";

  const subject =
    "Your AF Digital Hub course is ready";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtmlEmail(safeCourseTitle)}</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#05050b;
  color:#f8f8fc;
  font-family:Arial,Helvetica,sans-serif;
">

<div style="
  max-width:620px;
  margin:0 auto;
  padding:35px 20px;
">

  <div style="
    background:#0f101a;
    border:1px solid #202235;
    border-radius:18px;
    padding:30px 24px;
  ">

    <div style="
      font-size:22px;
      font-weight:800;
      margin-bottom:25px;
    ">
      AF Digital <span style="color:#ffd21a;">Hub</span>
    </div>

    <h1 style="
      font-size:25px;
      line-height:1.25;
      margin:0 0 15px;
      color:#ffffff;
    ">
      Your course is ready 🎓
    </h1>

    <p style="
      color:#c5cad8;
      font-size:15px;
      line-height:1.7;
      margin:0 0 18px;
    ">
      Hi ${escapeHtmlEmail(safeName)},
    </p>

    <p style="
      color:#c5cad8;
      font-size:15px;
      line-height:1.7;
      margin:0 0 18px;
    ">
      Your payment was successfully verified and your course
      access is now active.
    </p>

    <div style="
      background:#151724;
      border:1px solid #292c40;
      border-radius:13px;
      padding:18px;
      margin:22px 0;
    ">

      <div style="
        color:#8992a7;
        font-size:12px;
        margin-bottom:7px;
      ">
        COURSE
      </div>

      <div style="
        color:#ffffff;
        font-size:17px;
        font-weight:800;
        line-height:1.45;
      ">
        ${escapeHtmlEmail(safeCourseTitle)}
      </div>

    </div>

    <p style="
      color:#c5cad8;
      font-size:15px;
      line-height:1.7;
      margin:0 0 24px;
    ">
      Your access is active. Open your dashboard or start
      learning now.
    </p>

    <div style="
      text-align:center;
      margin:28px 0 12px;
    ">

      <a
        href="${escapeAttributeEmail(dashboardUrl)}"
        style="
          display:inline-block;
          background:#ffd21a;
          color:#07070a;
          text-decoration:none;
          padding:14px 24px;
          border-radius:10px;
          font-size:14px;
          font-weight:800;
          margin:5px;
        "
      >
        Open My Dashboard
      </a>

    </div>

    <div style="
      text-align:center;
      margin:12px 0 28px;
    ">

      <a
        href="${escapeAttributeEmail(courseUrl)}"
        style="
          display:inline-block;
          background:#1b1e2c;
          color:#ffffff;
          text-decoration:none;
          border:1px solid #34384d;
          padding:13px 24px;
          border-radius:10px;
          font-size:14px;
          font-weight:800;
          margin:5px;
        "
      >
        Start Learning
      </a>

    </div>

    <p style="
      color:#8992a7;
      font-size:12px;
      line-height:1.6;
      margin-top:25px;
    ">
      If you are not currently signed in, AF Digital Hub will
      take you through the normal sign-in process before
      opening your account.
    </p>

    <div style="
      border-top:1px solid #202235;
      margin-top:25px;
      padding-top:20px;
      color:#8992a7;
      font-size:11px;
      line-height:1.6;
    ">
      AF Digital Hub<br>
      Learn. Create. Sell. Connect.
    </div>

  </div>

</div>

</body>
</html>
`;

  const text = `
Hi ${safeName},

Your payment was successfully verified and your course access is now active.

Course:
${safeCourseTitle}

Open My Dashboard:
${dashboardUrl}

Start Learning:
${courseUrl}

You can start learning immediately from your AF Digital Hub account.

AF Digital Hub
Learn. Create. Sell. Connect.
`;

  try {
    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json",

          "Idempotency-Key":
            `course-access-${paymentReference}`
        },

        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [email],
          subject,
          html,
          text
        })
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "Resend course email failed:",
        data
      );

      return {
        ok: false,
        reason: "resend_failed",
        detail:
          data.message ||
          "Resend rejected the email"
      };
    }

    console.log(
      "Course access email sent:",
      {
        email,
        courseId,
        paymentReference,
        resendId: data.id || null
      }
    );

    return {
      ok: true,
      resend_id:
        data.id || null
    };

  } catch (err) {

    console.error(
      "Course access email error:",
      err
    );

    return {
      ok: false,
      reason: "email_request_failed",
      detail: err.message
    };
  }
}

function escapeHtmlEmail(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttributeEmail(value) {
  return escapeHtmlEmail(value);
}

/* =========================================================
   PAYSTACK VERIFICATION
========================================================= */

async function verifyAndComplete(reference) {

  const verifyRes =
    await fetch(
      `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization:
            `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

  const verifyData =
    await verifyRes.json();

  if (
    !verifyRes.ok ||
    !verifyData.status
  ) {

    return {
      ok: false,
      reason: "verification_failed",
      detail:
        verifyData.message ||
        "Paystack did not confirm this payment"
    };
  }

  const txn =
    verifyData.data;

  const client =
    await pool.connect();

  let courseEmailData =
    null;

  try {

    await client.query("BEGIN");

    const paymentResult =
      await client.query(
        "SELECT * FROM payments WHERE provider_reference = $1 FOR UPDATE",
        [reference]
      );

    if (
      paymentResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      return {
        ok: false,
        reason: "unknown_payment"
      };
    }

    const payment =
      paymentResult.rows[0];

    /*
     * Prevent webhook + /verify from processing
     * the same successful payment twice.
     */
    if (
      payment.status === "successful"
    ) {

      await client.query(
        "ROLLBACK"
      );

      return {
        ok: true,
        already_processed: true,
        order_id:
          payment.order_id
      };
    }

    const orderResult =
      await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
        [payment.order_id]
      );

    if (
      orderResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      return {
        ok: false,
        reason: "unknown_order"
      };
    }

    const order =
      orderResult.rows[0];

    /* =====================================================
       PAYMENT STATUS
    ===================================================== */

    if (
      txn.status !== "success"
    ) {

      await client.query(
        `UPDATE payments
         SET status = $1,
             raw_response = $2
         WHERE id = $3`,
        [
          txn.status === "abandoned"
            ? "abandoned"
            : "failed",
          JSON.stringify(txn),
          payment.id
        ]
      );

      await client.query(
        `UPDATE orders
         SET status = 'failed',
             updated_at = now()
         WHERE id = $1`,
        [order.id]
      );

      await client.query(
        "COMMIT"
      );

      return {
        ok: false,
        reason:
          "payment
