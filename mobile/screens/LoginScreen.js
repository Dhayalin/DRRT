import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { login, apiRequest, API_BASE } from '../lib/api';
import { colors } from '../lib/theme';

export default function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('survivor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      let data;
      if (mode === 'register') {
        if (!username || !password || !fullName) throw new Error('Fill in all fields.');
        data = await apiRequest('/auth/register', { method: 'POST', body: { username, password, full_name: fullName, role } });
      } else {
        if (!username || !password) throw new Error('Enter username and password.');
        data = await login(username, password);
      }
      onLogin(data);
    } catch (e) {
      setError(e.message || `Could not reach DRRT API at ${API_BASE}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>DRRT</Text>
      <Text style={styles.sub}>Offline-first disaster relief coordination</Text>

      <View style={styles.tabs}>
        <TouchableOpacity style={[styles.tab, mode === 'login' && styles.tabActive]} onPress={() => setMode('login')}>
          <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>Sign in</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, mode === 'register' && styles.tabActive]} onPress={() => setMode('register')}>
          <Text style={[styles.tabText, mode === 'register' && styles.tabTextActive]}>Register</Text>
        </TouchableOpacity>
      </View>

      {mode === 'register' && (
        <>
          <Text style={styles.label}>Full name</Text>
          <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholderTextColor={colors.textFaint} />
          <Text style={styles.label}>I am a…</Text>
          <View style={styles.roleRow}>
            {['survivor', 'volunteer', 'authority'].map((r) => (
              <TouchableOpacity key={r} style={[styles.roleChip, role === r && styles.roleChipActive]} onPress={() => setRole(r)}>
                <Text style={[styles.roleChipText, role === r && styles.roleChipTextActive]}>{r}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}

      <Text style={styles.label}>Username</Text>
      <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" placeholderTextColor={colors.textFaint} />
      <Text style={styles.label}>Password</Text>
      <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" placeholderTextColor={colors.textFaint} />

      <TouchableOpacity style={styles.btn} onPress={submit} disabled={busy}>
        <Text style={styles.btnText}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</Text>
      </TouchableOpacity>
      {!!error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.hint}>
        <Text style={styles.hintText}>Demo accounts (password: password123):</Text>
        <Text style={styles.hintText}>survivor1 · vol1 · authority1</Text>
        <Text style={styles.hintText}>API: {API_BASE}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  sub: { color: colors.textDim, fontSize: 13, marginBottom: 20 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 18 },
  tab: { flex: 1, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.amber },
  tabText: { color: colors.textFaint, textAlign: 'center' },
  tabTextActive: { color: colors.text },
  label: { color: colors.textDim, fontSize: 12, marginTop: 12, marginBottom: 5 },
  input: {
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, color: colors.text,
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  roleRow: { flexDirection: 'row', gap: 8 },
  roleChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  roleChipActive: { borderColor: colors.amber, backgroundColor: 'rgba(242,169,59,0.12)' },
  roleChipText: { color: colors.textDim, fontSize: 12, textTransform: 'capitalize' },
  roleChipTextActive: { color: colors.amber },
  btn: { backgroundColor: colors.amber, borderRadius: 8, paddingVertical: 13, marginTop: 20, alignItems: 'center' },
  btnText: { color: '#1a1206', fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, marginTop: 10, fontFamily: 'monospace' },
  hint: { marginTop: 22, padding: 12, backgroundColor: colors.panel2, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  hintText: { color: colors.textDim, fontSize: 11, fontFamily: 'monospace', lineHeight: 18 },
});
