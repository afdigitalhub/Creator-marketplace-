const express = require("express");

const router = express.Router();

/*
  AF Digital Hub weekly withdrawal window.

  Every Friday:
  12:00 AM - 5:30 PM

  The platform uses UTC as its fixed global withdrawal
  window. Ghana is also UTC, so this matches Ghana time.
*/

const WITHDRAWAL_DAY = 5; // Friday
const OPEN_MINUTES = 0; // 12:00 AM
const CLOSE_MINUTES = 17 * 60 + 30; // 5:30 PM

function getWithdrawalWindow(date = new Date()) {
  const day = date.getUTCDay();

  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();

  const currentMinutes = hours * 60 + minutes;

  const isFriday = day === WITHDRAWAL_DAY;

  const open =
    isFriday &&
    currentMinutes >= OPEN_MINUTES &&
    currentMinutes <= CLOSE_MINUTES;

  return {
    open,
    day: "Friday",
    start: "00:00",
    end: "17:30",
    timezone: "UTC",
    fee: 0,
    message: open
      ? "Withdrawals are live now. You can submit your withdrawal request."
      : "Withdrawals are available every Friday from 12:00 AM to 5:30 PM."
  };
}

/*
  GET /withdrawal-window/status

  Public status endpoint.
*/
router.get("/status", (req, res) => {
  try {
    const window = getWithdrawalWindow();

    res.json({
      success: true,
      ...window
    });
  } catch (err) {
    console.error(
      "Withdrawal window status error:",
      err
    );

    res.status(500).json({
      success: false,
      error:
        "Unable to check withdrawal window."
    });
  }
});

module.exports = router;

/*
  Export the helper so withdrawals.js
  can use the exact same withdrawal window.
*/
module.exports.getWithdrawalWindow =
  getWithdrawalWindow;
