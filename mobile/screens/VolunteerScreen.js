import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert, FlatList, Image,
} from 'react-native';
import { apiRequest } from '../lib/api';
import { enqueue } from '../lib/offlineQueue';
import { colors } from '../lib/theme';

const LEVELS = ['OK', 'Low', 'Out'];

export default function VolunteerScreen({ session, online, onLogout, onQueueChange }) {
  const [tab, setTab] = useState('update'); // 'update' | 'verify'
  const [shelters, setShelters] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ occupancy: '0', capacity: '0', food: 'OK', water: 'OK', medicine: 'OK', medical_facility: 'Available' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        apiRequest('/shelters', { token: session.token }),
        apiRequest('/incidents', { token: session.token }),
      ]);
      setShelters(s);
      setIncidents(i);
      if (!selected && s.length) selectShelter(s[0]);
    } catch (e) { /* stay on cached data if offline */ }
  }, [session.token, selected]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const selectShelter = (s) => {
    setSelected(s);
    setForm({
      occupancy: String(s.occupancy), capacity: String(s.capacity),
      food: s.food, water: s.water, medicine: s.medicine, medical_facility: s.medical_facility,
    });
  };

  const pushUpdate = async () => {
    if (!selected) return;
    setBusy(true);
    const payload = {
      code: selected.code,
      base_version: selected.version,
      occupancy: parseInt(form.occupancy || '0', 10),
      capacity: parseInt(form.capacity || '0', 10),
      food: form.food, water: form.water, medicine: form.medicine, medical_facility: form.medical_facility,
    };
    const client_timestamp = new Date().toISOString();
    try {
      if (online) {
        const updated = await apiRequest(`/shelters/${selected.code}`, {
          method: 'PATCH', token: session.token, body: { ...payload, client_timestamp },
        });
        Alert.alert('Update pushed', `${selected.name} is now at version ${updated.version}.`);
        load();
      } else {
        await enqueue('shelter_update', payload);
        onQueueChange && onQueueChange();
        Alert.alert('Saved offline', 'Queued for sync when reconnected.');
      }
    } catch (e) {
      Alert.alert('Update failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (code) => {
    try {
      if (online) {
        await apiRequest(`/incidents/${code}/verify`, { method: 'POST', token: session.token });
        load();
      } else {
        await enqueue('verify_incident', { code });
        onQueueChange && onQueueChange();
        setIncidents((prev) => prev.map((i) => (i.code === code ? { ...i, verified: true } : i)));
      }
    } catch (e) {
      Alert.alert('Verify failed', e.message);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabs}>
        <TouchableOpacity style={[styles.tab, tab === 'update' && styles.tabActive]} onPress={() => setTab('update')}>
          <Text style={[styles.tabText, tab === 'update' && styles.tabTextActive]}>Update shelter</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, tab === 'verify' && styles.tabActive]} onPress={() => setTab('verify')}>
          <Text style={[styles.tabText, tab === 'verify' && styles.tabTextActive]}>Verify incidents</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.logout} onPress={onLogout}><Text style={styles.logoutText}>Log out</Text></TouchableOpacity>
      </View>

      {tab === 'update' && (
        <ScrollView contentContainerStyle={{ padding: 18 }}>
          <Text style={styles.label}>Shelter</Text>
          <View style={styles.chipRow}>
            {shelters.map((s) => (
              <TouchableOpacity key={s.code} style={[styles.chip, selected?.code === s.code && styles.chipActive]} onPress={() => selectShelter(s)}>
                <Text style={[styles.chipText, selected?.code === s.code && styles.chipTextActive]}>{s.code}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {selected && (
            <>
              <Text style={styles.shelterName}>{selected.name} · v{selected.version}</Text>
              <View style={styles.row2}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Occupancy</Text>
                  <TextInput style={styles.input} keyboardType="number-pad" value={form.occupancy} onChangeText={(v) => setForm({ ...form, occupancy: v })} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Capacity</Text>
                  <TextInput style={styles.input} keyboardType="number-pad" value={form.capacity} onChangeText={(v) => setForm({ ...form, capacity: v })} />
                </View>
              </View>

              <LevelPicker label="Food stock" value={form.food} onChange={(v) => setForm({ ...form, food: v })} />
              <LevelPicker label="Water stock" value={form.water} onChange={(v) => setForm({ ...form, water: v })} />
              <LevelPicker label="Medicine stock" value={form.medicine} onChange={(v) => setForm({ ...form, medicine: v })} />
              <Text style={styles.label}>Medical facility</Text>
              <View style={styles.chipRow}>
                {['Available', 'Unavailable'].map((v) => (
                  <TouchableOpacity key={v} style={[styles.chip, form.medical_facility === v && styles.chipActive]} onPress={() => setForm({ ...form, medical_facility: v })}>
                    <Text style={[styles.chipText, form.medical_facility === v && styles.chipTextActive]}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.gpsNote}>
                Conflicting edits are merged field-by-field on the server — if another volunteer changed a
                different field first, your update still applies.
              </Text>

              <TouchableOpacity style={styles.btn} onPress={pushUpdate} disabled={busy}>
                {busy ? <ActivityIndicator color="#1a1206" /> : <Text style={styles.btnText}>Push update</Text>}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      )}

      {tab === 'verify' && (
        <FlatList
          data={incidents.filter((i) => !i.verified)}
          keyExtractor={(i) => i.code}
          contentContainerStyle={{ padding: 18 }}
          onRefresh={load}
          refreshing={false}
          ListEmptyComponent={<Text style={styles.empty}>Nothing awaiting verification.</Text>}
          renderItem={({ item: i }) => (
            <View style={styles.incRow}>
              {i.photo_path ? <Image source={{ uri: `http://localhost:8000${i.photo_path}` }} style={styles.thumb} /> : null}
              <View style={{ flex: 1 }}>
                <Text style={styles.incTitle}>{i.type} — {i.description}</Text>
                <Text style={styles.incMeta}>{i.code} · reported by {i.reported_by}</Text>
              </View>
              <TouchableOpacity style={styles.verifyBtn} onPress={() => verify(i.code)}>
                <Text style={styles.verifyBtnText}>Verify</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

function LevelPicker({ label, value, onChange }) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {LEVELS.map((l) => (
          <TouchableOpacity key={l} style={[styles.chip, value === l && styles.chipActive]} onPress={() => onChange(l)}>
            <Text style={[styles.chipText, value === l && styles.chipTextActive]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, alignItems: 'center' },
  tab: { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.amber },
  tabText: { color: colors.textFaint, fontSize: 12.5 },
  tabTextActive: { color: colors.text },
  logout: { marginLeft: 'auto', paddingHorizontal: 14 },
  logoutText: { color: colors.textFaint, fontSize: 11 },
  label: { color: colors.textDim, fontSize: 12, marginTop: 14, marginBottom: 6 },
  shelterName: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 16 },
  row2: { flexDirection: 'row', gap: 12 },
  input: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, color: colors.text, borderRadius: 6, padding: 10, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  chipActive: { borderColor: colors.amber, backgroundColor: 'rgba(242,169,59,0.12)' },
  chipText: { color: colors.textDim, fontSize: 12 },
  chipTextActive: { color: colors.amber },
  gpsNote: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'monospace', marginTop: 14, lineHeight: 15 },
  btn: { backgroundColor: colors.amber, borderRadius: 8, paddingVertical: 13, marginTop: 18, alignItems: 'center' },
  btnText: { color: '#1a1206', fontWeight: '700' },
  empty: { color: colors.textFaint, fontSize: 12, fontFamily: 'monospace', textAlign: 'center', padding: 20 },
  incRow: {
    flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: colors.panel2, borderWidth: 1,
    borderColor: colors.border, borderRadius: 8, padding: 10, marginBottom: 10,
  },
  thumb: { width: 44, height: 44, borderRadius: 4 },
  incTitle: { color: colors.text, fontSize: 13 },
  incMeta: { color: colors.textFaint, fontSize: 10, fontFamily: 'monospace', marginTop: 2 },
  verifyBtn: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  verifyBtnText: { color: colors.text, fontSize: 11 },
});
