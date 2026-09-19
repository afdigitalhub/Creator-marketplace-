const express = require("express");

const router = express.Router();

const WITHDRAWAL_DAY = 5; // Friday
const OPEN_HOUR = 0;       // 12:00 AM
const CLOSE_HOUR = 17;     // 5:30 PM

function getWithdrawalWindowStatus(date = new Date()) {
  const day = date.getUTCDay();

  if (day !== WITHDRAWAL_DAY) {
    return {
      open: false,
      day: "Friday",
      start: "00:00",
      end: "17:30",
      message: "Withdrawals are available every Friday from 12:00 AM to 5:30 PM."
    };
  }

  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  const startMinutes = OPEN_HOUR * 60;
  const endMinutes = 17 * 60 + 30;

  const open = totalMinutes >= startMinutes && totalMinutes <= endMinutes;

  return {
    open,
    day: "Friday",
    start: "00:00",
    end: "17:30",
    message: open
      ? "Withdrawals are live now. You can submit your withdrawal request."
      : "Today's withdrawal window has closed."
  };
}

router.get("/status", (req, res) => {
  try {
    const status = getWithdrawalWindowStatus();

    res.json({
      success: true,
      ...status,
      timezone: "UTC",
      withdrawal_fee: 0,
      fee_currency: null
    });
  } catch (error) {
    console.error("Withdrawal window error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to check withdrawal window."
    });
  }
});

module.exports = router;
