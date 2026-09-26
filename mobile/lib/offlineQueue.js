import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest, API_BASE } from './api';

const QUEUE_KEY = 'drrt_offline_queue_v1';

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getQueue() {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function setQueue(q) {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/**
 * Enqueue an action while offline. `photoUri` (a local file:// URI from the
 * camera/picker) is stored as-is; we upload the real file once we're back
 * online rather than base64-encoding it into AsyncStorage.
 */
export async function enqueue(kind, payload, photoUri = null) {
  const item = {
    client_uuid: uuidv4(),
    kind,
    client_timestamp: new Date().toISOString(),
    payload,
    photoUri,
  };
  const q = await getQueue();
  q.push(item);
  await setQueue(q);
  return item;
}

/**
 * Replay the queue against the backend. Incident reports with a photo go
 * through the multipart /incidents endpoint (idempotent via client_uuid);
 * everything else batches through /sync/batch (also idempotent).
 */
export async function flushQueue(token, onResult) {
  const q = await getQueue();
  if (q.length === 0) return { synced: 0, remaining: 0 };

  const photoItems = q.filter((i) => i.kind === 'incident_report' && i.photoUri);
  const batchItems = q.filter((i) => !(i.kind === 'incident_report' && i.photoUri));
  let remaining = [...q];

  for (const item of photoItems) {
    try {
      const form = new FormData();
      form.append('type', item.payload.type);
      form.append('description', item.payload.description || '');
      if (item.payload.lat != null) form.append('lat', String(item.payload.lat));
      if (item.payload.lon != null) form.append('lon', String(item.payload.lon));
      form.append('client_uuid', item.client_uuid);
      form.append('photo', { uri: item.photoUri, name: 'photo.jpg', type: 'image/jpeg' });
      await apiRequest('/incidents', { method: 'POST', token, form });
      remaining = remaining.filter((r) => r.client_uuid !== item.client_uuid);
      onResult && onResult({ kind: item.kind, outcome: 'applied', detail: 'photo incident synced' });
    } catch (e) {
      onResult && onResult({ kind: item.kind, outcome: 'rejected', detail: e.message });
      // left in queue, will retry next flush
    }
  }
  await setQueue(remaining);

  if (batchItems.length) {
    try {
      const res = await apiRequest('/sync/batch', {
        method: 'POST',
        token,
        body: {
          actions: batchItems.map((i) => ({
            client_uuid: i.client_uuid,
            kind: i.kind,
            client_timestamp: i.client_timestamp,
            payload: i.payload,
          })),
        },
      });
      const done = new Set(res.results.map((r) => r.client_uuid));
      res.results.forEach((r) => onResult && onResult(r));
      remaining = (await getQueue()).filter((i) => !done.has(i.client_uuid));
      await setQueue(remaining);
    } catch (e) {
      onResult && onResult({ kind: 'batch', outcome: 'rejected', detail: e.message });
    }
  }

  const left = await getQueue();
  return { synced: q.length - left.length, remaining: left.length };
}

export async function queueLength() {
  return (await getQueue()).length;
}
