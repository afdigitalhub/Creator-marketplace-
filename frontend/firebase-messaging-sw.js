// AF Digital Hub — Firebase Cloud Messaging Service Worker
// This file MUST live at the root of the served site (same folder as index.html)
// so it can be reached at https://afdigitalhub.net/firebase-messaging-sw.js

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD67x0ebY8WpPMRLoaZLk959cLL_HlgVv8",
  authDomain: "af-digital-hub.firebaseapp.com",
  projectId: "af-digital-hub",
  storageBucket: "af-digital-hub.firebasestorage.app",
  messagingSenderId: "328529622262",
  appId: "1:328529622262:web:beff63543f828e5c2968d7",
  measurementId: "G-FE4Q9LDW31"
});

const messaging = firebase.messaging();

// Handles notifications that arrive while the site is closed or in the background
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "AF Digital Hub";
  const options = {
    body: payload.notification?.body || "",
    icon: "/icons/logo-mark.png"
  };
  self.registration.showNotification(title, options);
});

// A real fetch handler — required by Chrome for the "Install App" prompt to
// appear. This is a simple pass-through: try the network first, and if that
// fails (no connection), fall back to anything already cached for that page.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate this service worker immediately for anyone already on the site,
// instead of waiting for them to close and reopen their browser.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
