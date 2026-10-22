// Web Push on this device: register the service worker, subscribe/unsubscribe, report status.
import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone/iPad Safari only allows push for apps added to the Home Screen. */
export const needsHomeScreen = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !pushSupported();

let registration = null;
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  registration ||= navigator.serviceWorker.register('/sw.js').catch(() => null);
  navigator.serviceWorker.addEventListener('message', (event) => {
    const target = event.data?.navigate;
    if (!target) return;
    const url = new URL(target);
    if (url.origin === location.origin) location.hash = url.hash || '#/';
  });
  return registration;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  return !!(await currentSubscription());
}

function keyBytes(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked — allow them in your browser settings');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Couldn't reach this browser's push service — try again later")), 20000));
    sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }), timeout]);
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

export const sendTestPush = () => api('/push/test', { method: 'POST' });
