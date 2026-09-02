require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const profileRoutes = require("./routes/profiles");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/profile", profileRoutes);

app.get("/", (req, res) => res.json({ status: "Creator Marketplace API — Phase 1 (auth + roles)" }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`Creator Marketplace backend running on port ${PORT}`));
