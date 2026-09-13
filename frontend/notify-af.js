// AF Digital Hub — Automatic notification permission prompt
// Asks for notification permission automatically a couple seconds after the page loads.
// The button (if present) still shows the current status, but visitors no longer need to tap it.

document.addEventListener("DOMContentLoaded", function () {
  const notifyBtn = document.getElementById("notify-me-btn");

  const firebaseConfig = {
    apiKey: "AIzaSyD67x0ebY8WpPMRLoaZLk959cLL_HlgVv8",
    authDomain: "af-digital-hub.firebaseapp.com",
    projectId: "af-digital-hub",
    storageBucket: "af-digital-hub.firebasestorage.app",
    messagingSenderId: "328529622262",
    appId: "1:328529622262:web:beff63543f828e5c2968d7",
    measurementId: "G-FE4Q9LDW31"
  };

  function markButtonOn() {
    if (!notifyBtn) return;
    notifyBtn.textContent = "✓ Notifications On";
    notifyBtn.style.color = "#34d399";
    notifyBtn.style.borderColor = "#34d399";
    notifyBtn.style.opacity = "1";
    notifyBtn.style.cursor = "default";
    notifyBtn.disabled = true;
  }

  async function enableNotifications() {
    try {
      if (!("Notification" in window)) return;

      // If the visitor already answered before (allowed or blocked), don't ask again.
      if (Notification.permission === "denied") return;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;

      const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      const messaging = firebase.messaging();

      const token = await messaging.getToken({
        vapidKey: "BNQc5cylxKrcPUxY0B5grGLpNU9fkpWX5cPwa2dJCUokGPYIZ_QCyrOFBTIq0N7DQW7AE1swuznMjzqYbK0F_TU",
        serviceWorkerRegistration: registration
      });

      if (token) {
        markButtonOn();
      }
    } catch (err) {
      console.error("Notify Me error:", err);
    }
  }

  // If the visitor already has permission granted from before, just reflect that on the button.
  if ("Notification" in window && Notification.permission === "granted") {
    enableNotifications();
  } else {
    // Ask automatically, a couple seconds after the page loads.
    setTimeout(enableNotifications, 2000);
  }

  // Keep the button working too, in case someone dismissed the prompt and wants to try again.
  if (notifyBtn) {
    notifyBtn.addEventListener("click", enableNotifications);
  }
});
