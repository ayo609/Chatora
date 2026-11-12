// Chatora push service worker. Keep this file in the SAME folder as chat.html (it must be reachable at /firebase-messaging-sw.js or next to chat.html).
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyDLVQaV9gmlNFDkQLtTytl71F_aJk15xXg",
  authDomain: "chatora-c309f.firebaseapp.com",
  projectId: "chatora-c309f",
  storageBucket: "chatora-c309f.firebasestorage.app",
  messagingSenderId: "619677340839",
  appId: "1:619677340839:web:795c3fd79d87c8d05db782"
});
const messaging = firebase.messaging();

// Data-only messages: we build the notification ourselves so message and call alerts look right.
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {}, call = d.kind === 'call';
  return self.registration.showNotification(d.title || 'Chatora', {
    body: d.body || '',
    icon: d.icon || 'chatora-logo.png',
    badge: d.icon || 'chatora-logo.png',
    tag: d.tag || 'chatora',            // same tag = replaces the older notification from that chat
    renotify: true,
    requireInteraction: call,           // call alerts stay until you tap them
    vibrate: call ? [300, 150, 300, 150, 300, 150, 300] : [120],
    data: { url: d.url || 'chat.html', chatId: d.chatId || '', callId: d.callId || '' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'open', chatId: data.chatId, callId: data.callId }); return c.focus(); } }
    return self.clients.openWindow(data.url || 'chat.html');
  }));
});
