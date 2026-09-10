require("dotenv").config();

const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const profileRoutes = require("./routes/profiles");
const professionalProfileRoutes = require("./routes/professionalProfiles");
const productRoutes = require("./routes/products");
const campaignRoutes = require("./routes/campaigns");
const applicationRoutes = require("./routes/applications");
const deliverableRoutes = require("./routes/deliverables");
const payoutRoutes = require("./routes/payouts");
const reviewRoutes = require("./routes/reviews");
const notificationRoutes = require("./routes/notifications");
const adminRoutes = require("./routes/admin");
const messageRoutes = require("./routes/messages");
const orderRoutes = require("./routes/orders");
const libraryRoutes = require("./routes/library");
const paymentRoutes = require("./routes/payments");
const earningsRoutes = require("./routes/earnings");
const productReviewRoutes = require("./routes/productReviews");
const withdrawalRoutes = require("./routes/withdrawals");
const adminStatsRoutes = require("./routes/adminStats");

/* AF INTELLIGENT AI */
const aiRoutes = require("./routes/ai");

const app = express();

app.use(cors());

/*
  Paystack payments must be mounted BEFORE the global JSON parser.
  The webhook needs the raw request body to verify its signature.
*/
app.use("/payments", paymentRoutes);

app.use(express.json());

/* Existing AF Digital Hub routes */
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/profiles", profileRoutes);
app.use("/professional-profiles", professionalProfileRoutes);
app.use("/products", productRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/applications", applicationRoutes);
app.use("/deliverables", deliverableRoutes);
app.use("/payouts", payoutRoutes);
app.use("/reviews", reviewRoutes);
app.use("/product-reviews", productReviewRoutes);
app.use("/notifications", notificationRoutes);
app.use("/admin", adminRoutes);
app.use("/admin-stats", adminStatsRoutes);
app.use("/messages", messageRoutes);
app.use("/orders", orderRoutes);
app.use("/library", libraryRoutes);
app.use("/earnings", earningsRoutes);
app.use("/withdrawals", withdrawalRoutes);

/* AF Intelligent AI */
app.use("/ai", aiRoutes);

/* API health check */
app.get("/", (req, res) => {
  res.json({
    status: "Creator Marketplace API running",
    ai: "AF Intelligent AI enabled"
  });
});

const PORT = process.env.PORT || 4001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Creator Marketplace API running on port ${PORT}`
  );
});
