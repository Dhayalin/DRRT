import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Image, Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { apiRequest } from '../lib/api';
import { enqueue } from '../lib/offlineQueue';
import { colors } from '../lib/theme';

const INCIDENT_TYPES = ['Flood', 'Fire', 'Road Block', 'Building Collapse', 'Landslide', 'Injured Person'];

function occStatus(s) {
  const pct = s.occupancy / s.capacity;
  if (pct >= 1) return { label: 'FULL', color: colors.danger };
  if (pct >= 0.85) return { label: 'LIMITED', color: colors.amber };
  return { label: 'OPEN', color: colors.safe };
}

async function getGps() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return { error: 'Location permission denied.' };
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
  } catch (e) {
    return { error: e.message || 'Could not get GPS fix.' };
  }
}

export default function SurvivorScreen({ session, online, onLogout, onQueueChange }) {
  const [shelters, setShelters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('shelters'); // 'shelters' | 'sos' | 'report'

  const load = useCallback(async () => {
    try {
      const data = await apiRequest('/shelters', { token: session.token });
      setShelters(data);
    } catch (e) {
      // offline or backend down -- keep showing whatever we last had
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabs}>
        {['shelters', 'sos', 'report'].map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'shelters' ? 'Shelters' : t === 'sos' ? 'SOS' : 'Report'}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.logout} onPress={onLogout}><Text style={styles.logoutText}>Log out</Text></TouchableOpacity>
      </View>

      {tab === 'shelters' && (
        loading ? <ActivityIndicator color={colors.amber} style={{ marginTop: 30 }} /> : (
          <FlatList
            data={shelters}
            keyExtractor={(s) => s.code}
            contentContainerStyle={{ padding: 14 }}
            onRefresh={load}
            refreshing={false}
            renderItem={({ item: s }) => {
              const st = occStatus(s);
              return (
                <View style={styles.card}>
                  <View style={styles.cardHead}>
                    <View>
                      <Text style={styles.cardName}>{s.name}</Text>
                      <Text style={styles.cardId}>{s.code}</Text>
                    </View>
                    <View style={[styles.chip, { borderColor: st.color }]}><Text style={{ color: st.color, fontSize: 10 }}>{st.label}</Text></View>
                  </View>
                  <Text style={styles.cardLine}>{s.occupancy}/{s.capacity} occupied · {Math.max(s.capacity - s.occupancy, 0)} beds free</Text>
                  <View style={styles.badgeRow}>
                    <Badge label={`FOOD · ${s.food}`} level={s.food} />
                    <Badge label={`WATER · ${s.water}`} level={s.water} />
                    <Badge label={`MEDICAL · ${s.medical_facility}`} level={s.medical_facility === 'Available' ? 'OK' : 'Out'} />
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>No shelter data cached yet — connect once to load it.</Text>}
          />
        )
      )}

      {tab === 'sos' && <SosPanel session={session} online={online} onQueueChange={onQueueChange} />}
      {tab === 'report' && <ReportPanel session={session} online={online} onQueueChange={onQueueChange} />}
    </View>
  );
}

function Badge({ label, level }) {
  const color = level === 'OK' ? colors.safe : level === 'Low' ? colors.amber : colors.danger;
  return <View style={[styles.badge, { borderColor: color }]}><Text style={{ color, fontSize: 10, fontFamily: 'monospace' }}>{label}</Text></View>;
}

function SosPanel({ session, online, onQueueChange }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("Captures your real device GPS and sends it to the nearest authority.");

  const sendSos = async () => {
    setBusy(true);
    setNote('Requesting GPS fix…');
    const gps = await getGps();
    if (gps.error) {
      setNote('⚠ ' + gps.error);
      setBusy(false);
      return;
    }
    setNote(`Location: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} (±${Math.round(gps.accuracy || 0)}m)`);
    try {
      if (online) {
        const form = new FormData();
        form.append('lat', String(gps.lat));
        form.append('lon', String(gps.lon));
        form.append('gps_accuracy_m', String(gps.accuracy || 0));
        form.append('client_uuid', `${Date.now()}`);
        await apiRequest('/sos', { method: 'POST', token: session.token, form });
        Alert.alert('SOS sent', 'Your alert has reached the authority dashboard.');
      } else {
        await enqueue('sos', { lat: gps.lat, lon: gps.lon, gps_accuracy_m: gps.accuracy });
        onQueueChange && onQueueChange();
        Alert.alert('SOS saved offline', 'It will send automatically once you\u2019re back online.');
      }
    } catch (e) {
      Alert.alert('SOS failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <TouchableOpacity style={styles.sosBtn} onPress={sendSos} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sosBtnText}>SEND SOS</Text>}
      </TouchableOpacity>
      <Text style={styles.gpsNote}>{note}</Text>
    </View>
  );
}

function ReportPanel({ session, online, onQueueChange }) {
  const [type, setType] = useState(INCIDENT_TYPES[0]);
  const [desc, setDesc] = useState('');
  const [photo, setPhoto] = useState(null); // {uri}
  const [gps, setGps] = useState(null);
  const [gpsNote, setGpsNote] = useState('No location captured yet.');
  const [busy, setBusy] = useState(false);

  const captureGps = async () => {
    setGpsNote('Requesting GPS fix…');
    const g = await getGps();
    if (g.error) { setGpsNote('⚠ ' + g.error); return; }
    setGps(g);
    setGpsNote(`Captured: ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} (±${Math.round(g.accuracy || 0)}m)`);
  };

  const pickPhoto = async (fromCamera) => {
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') { Alert.alert('Permission needed', 'Enable camera/photo access to attach a photo.'); return; }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (!result.canceled) setPhoto(result.assets[0]);
  };

  const submit = async () => {
    if (!desc.trim()) { Alert.alert('Add a description', 'Say what you\u2019re seeing so responders can prioritize.'); return; }
    setBusy(true);
    try {
      const payload = { type, description: desc.trim(), lat: gps?.lat ?? null, lon: gps?.lon ?? null };
      if (online) {
        const form = new FormData();
        form.append('type', type);
        form.append('description', desc.trim());
        if (gps) { form.append('lat', String(gps.lat)); form.append('lon', String(gps.lon)); }
        form.append('client_uuid', `${Date.now()}`);
        if (photo) form.append('photo', { uri: photo.uri, name: 'photo.jpg', type: 'image/jpeg' });
        await apiRequest('/incidents', { method: 'POST', token: session.token, form });
        Alert.alert('Reported', 'Incident submitted to the authority feed.');
      } else {
        await enqueue('incident_report', payload, photo?.uri || null);
        onQueueChange && onQueueChange();
        Alert.alert('Saved offline', 'Queued — will sync automatically once reconnected.');
      }
      setDesc(''); setPhoto(null); setGps(null); setGpsNote('No location captured yet.');
    } catch (e) {
      Alert.alert('Report failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <Text style={styles.label}>Incident type</Text>
      <View style={styles.chipRow}>
        {INCIDENT_TYPES.map((t) => (
          <TouchableOpacity key={t} style={[styles.typeChip, type === t && styles.typeChipActive]} onPress={() => setType(t)}>
            <Text style={[styles.typeChipText, type === t && styles.typeChipTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={[styles.input, { minHeight: 70 }]}
        value={desc}
        onChangeText={setDesc}
        multiline
        placeholder="What are you seeing? Location details help."
        placeholderTextColor={colors.textFaint}
      />

      <Text style={styles.label}>Photo</Text>
      {photo ? (
        <Image source={{ uri: photo.uri }} style={styles.photoPreview} />
      ) : (
        <View style={styles.photoRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => pickPhoto(true)}><Text style={styles.secondaryBtnText}>📷 Camera</Text></TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => pickPhoto(false)}><Text style={styles.secondaryBtnText}>🖼 Library</Text></TouchableOpacity>
        </View>
      )}

      <TouchableOpacity style={styles.secondaryBtn} onPress={captureGps}><Text style={styles.secondaryBtnText}>📍 Capture GPS location</Text></TouchableOpacity>
      <Text style={styles.gpsNote}>{gpsNote}</Text>

      <TouchableOpacity style={styles.btn} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#1a1206" /> : <Text style={styles.btnText}>Report incident</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg, alignItems: 'center' },
  tab: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.amber },
  tabText: { color: colors.textFaint, fontSize: 13 },
  tabTextActive: { color: colors.text },
  logout: { marginLeft: 'auto', paddingHorizontal: 14 },
  logoutText: { color: colors.textFaint, fontSize: 11 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 14, marginBottom: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardName: { color: colors.text, fontWeight: '600', fontSize: 14.5 },
  cardId: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'monospace' },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  cardLine: { color: colors.textDim, fontSize: 11.5, fontFamily: 'monospace', marginTop: 8 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3 },
  empty: { color: colors.textFaint, fontSize: 12, fontFamily: 'monospace', padding: 20, textAlign: 'center' },
  sosBtn: { backgroundColor: colors.danger, borderRadius: 10, paddingVertical: 20, alignItems: 'center' },
  sosBtnText: { color: '#fff', fontWeight: '700', fontSize: 16, letterSpacing: 1 },
  gpsNote: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'monospace', marginTop: 8 },
  label: { color: colors.textDim, fontSize: 12, marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, color: colors.text, borderRadius: 6, padding: 10, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  typeChipActive: { borderColor: colors.amber, backgroundColor: 'rgba(242,169,59,0.12)' },
  typeChipText: { color: colors.textDim, fontSize: 12 },
  typeChipTextActive: { color: colors.amber },
  photoRow: { flexDirection: 'row', gap: 10 },
  photoPreview: { width: '100%', height: 160, borderRadius: 8, marginBottom: 6 },
  secondaryBtn: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', marginTop: 8 },
  secondaryBtnText: { color: colors.text, fontSize: 13 },
  btn: { backgroundColor: colors.amber, borderRadius: 8, paddingVertical: 13, marginTop: 18, alignItems: 'center' },
  btnText: { color: '#1a1206', fontWeight: '700' },
});
