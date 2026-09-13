// AF Digital Hub — Notify Me button logic
// Registers the service worker, asks for notification permission, and gets the device token.

document.addEventListener("DOMContentLoaded", function () {
  const notifyBtn = document.getElementById("notify-me-btn");
  if (!notifyBtn) return;

  notifyBtn.addEventListener("click", async function () {
    try {
      if (!("Notification" in window)) {
        alert("This browser does not support notifications.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        alert("Notifications were not allowed. You can turn them on later in your browser settings.");
        return;
      }

      const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

      const firebaseConfig = {
        apiKey: "AIzaSyD67x0ebY8WpPMRLoaZLk959cLL_HlgVv8",
        authDomain: "af-digital-hub.firebaseapp.com",
        projectId: "af-digital-hub",
        storageBucket: "af-digital-hub.firebasestorage.app",
        messagingSenderId: "328529622262",
        appId: "1:328529622262:web:beff63543f828e5c2968d7",
        measurementId: "G-FE4Q9LDW31"
      };

      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      const messaging = firebase.messaging();

      const token = await messaging.getToken({
        vapidKey: "BNQc5cylxKrcPUxY0B5grGLpNU9fkpWX5cPwa2dJCUokGPYIZ_QCyrOFBTIq0N7DQW7AE1swuznMjzqYbK0F_TU",
        serviceWorkerRegistration: registration
      });

      if (token) {
        notifyBtn.textContent = "✓ Notifications On";
        notifyBtn.style.color = "#34d399";
        notifyBtn.style.borderColor = "#34d399";
        notifyBtn.style.opacity = "1";
        notifyBtn.style.cursor = "default";
        notifyBtn.disabled = true;
      } else {
        alert("Could not get a notification token. Please try again.");
      }
    } catch (err) {
      console.error("Notify Me error:", err);
      alert("Something went wrong turning on notifications. Please try again later.");
    }
  });
});
