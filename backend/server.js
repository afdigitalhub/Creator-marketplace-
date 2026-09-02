require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const profileRoutes = require("./routes/profiles");
const campaignRoutes = require("./routes/campaigns");
const applicationRoutes = require("./routes/applications");
const deliverableRoutes = require("./routes/deliverables");
const payoutRoutes = require("./routes/payouts");
const reviewRoutes = require("./routes/reviews");
const notificationRoutes = require("./routes/notifications");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/profile", profileRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/applications", applicationRoutes);
app.use("/deliverables", deliverableRoutes);
app.use("/payouts", payoutRoutes);
app.use("/reviews", reviewRoutes);
app.use("/notifications", notificationRoutes);
app.use("/admin", adminRoutes);

app.get("/", (req, res) => res.json({ status: "Creator Marketplace API running" }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Creator Marketplace API running on port ${PORT}`));
