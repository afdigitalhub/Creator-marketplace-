require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const profileRoutes = require("./routes/profiles");
const campaignRoutes = require("./routes/campaigns");
const applicationRoutes = require("./routes/applications");
const deliverableRoutes = require("./routes/deliverables");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/profile", profileRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/applications", applicationRoutes);
app.use("/deliverables", deliverableRoutes);

app.get("/", (req, res) => res.json({ status: "Creator Marketplace API running" }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Creator Marketplace API running on port ${PORT}`));
