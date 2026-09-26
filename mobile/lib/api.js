// Same backend contract as the web dashboard (see /backend). Change this to
// your machine's LAN IP when testing on a physical device, since
// "localhost" on the phone means the phone itself, not your dev machine.
// e.g. export const API_BASE = 'http://192.168.1.42:8000';
export const API_BASE = 'http://localhost:8000';

export async function apiRequest(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let opts = { method, headers };
  if (form) {
    opts.body = form; // RN's fetch sets multipart boundary automatically
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error((data && data.detail) || `Request failed (${res.status})`);
  }
  return data;
}

export async function login(username, password) {
  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Login failed');
  return data; // {access_token, role, username, full_name}
}
