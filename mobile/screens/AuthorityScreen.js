import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image } from 'react-native';
import { apiRequest } from '../lib/api';
import { colors } from '../lib/theme';

export default function AuthorityScreen({ session, online, onLogout }) {
  const [summary, setSummary] = useState(null);
  const [shelters, setShelters] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [sos, setSos] = useState([]);
  const [syncLog, setSyncLog] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [sum, shel, inc, sosList, log] = await Promise.all([
        apiRequest('/dashboard/summary', { token: session.token }),
        apiRequest('/shelters', { token: session.token }),
        apiRequest('/incidents', { token: session.token }),
        apiRequest('/sos', { token: session.token }),
        apiRequest('/sync/log', { token: session.token }),
      ]);
      setSummary(sum); setShelters(shel); setIncidents(inc); setSos(sosList); setSyncLog(log);
    } catch (e) {
      // offline or backend unreachable -- keep last-known data on screen
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  if (loading && !summary) {
    return <View style={styles.center}><ActivityIndicator color={colors.amber} /></View>;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} onRefresh={load} refreshing={false}>
      <View style={styles.headRow}>
        <Text style={styles.heading}>Command dashboard</Text>
        <TouchableOpacity onPress={onLogout}><Text style={styles.logoutText}>Log out</Text></TouchableOpacity>
      </View>
      {!online && <Text style={styles.offlineNote}>Offline — showing last-synced data. Authority actions require a connection.</Text>}

      {summary && (
        <View style={styles.statsGrid}>
          <Stat label="Active shelters" value={summary.active_shelters} />
          <Stat label="Beds available" value={summary.beds_available} color={colors.safe} />
          <Stat label="Avg. occupancy" value={`${summary.avg_occupancy_pct}%`} color={colors.amber} />
          <Stat label="Open incidents" value={summary.open_incidents} color={colors.danger} />
          <Stat label="Open SOS" value={summary.open_sos} color={colors.danger} />
        </View>
      )}

      <SectionTitle>Shelter network</SectionTitle>
      {shelters.map((s) => {
        const pct = Math.min(Math.round((s.occupancy / s.capacity) * 100), 100);
        return (
          <View key={s.code} style={styles.shelterRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{s.name}</Text>
              <Text style={styles.rowMeta}>{s.occupancy}/{s.capacity} · food {s.food} · water {s.water} · v{s.version}</Text>
            </View>
            <View style={styles.pctBarTrack}><View style={[styles.pctBarFill, { width: `${pct}%` }]} /></View>
          </View>
        );
      })}

      <SectionTitle>Incident feed</SectionTitle>
      {incidents.length === 0 && <Text style={styles.empty}>No incidents reported.</Text>}
      {incidents.map((i) => (
        <View key={i.code} style={styles.incRow}>
          {i.photo_path ? <Image source={{ uri: `http://localhost:8000${i.photo_path}` }} style={styles.thumb} /> : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{i.type} — {i.description}</Text>
            <Text style={styles.rowMeta}>{i.code} · {i.reported_by}</Text>
          </View>
          <Text style={{ color: i.verified ? colors.safe : colors.amber, fontSize: 10, fontFamily: 'monospace' }}>
            {i.verified ? 'VERIFIED' : 'UNVERIFIED'}
          </Text>
        </View>
      ))}

      <SectionTitle>SOS alerts</SectionTitle>
      {sos.length === 0 && <Text style={styles.empty}>No SOS alerts.</Text>}
      {sos.map((a) => (
        <View key={a.id} style={styles.incRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{a.user} — {a.status}</Text>
            <Text style={styles.rowMeta}>{a.lat.toFixed(4)}, {a.lon.toFixed(4)}</Text>
          </View>
        </View>
      ))}

      <SectionTitle>Sync activity</SectionTitle>
      {syncLog.length === 0 && <Text style={styles.empty}>No server activity yet.</Text>}
      {syncLog.slice(0, 10).map((e, idx) => (
        <View key={idx} style={styles.logRow}>
          <Text style={styles.logText}>{e.actor} · {e.action} {e.entity_id || ''} — {e.detail}</Text>
          <Text style={[styles.logOutcome, { color: e.outcome === 'applied' ? colors.safe : e.outcome === 'conflict_merged' ? colors.danger : colors.textDim }]}>
            {e.outcome}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function Stat({ label, value, color }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statNum, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLbl}>{label}</Text>
    </View>
  );
}
function SectionTitle({ children }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heading: { color: colors.text, fontSize: 18, fontWeight: '700' },
  logoutText: { color: colors.textFaint, fontSize: 11 },
  offlineNote: { color: colors.amber, fontSize: 11, fontFamily: 'monospace', marginTop: 8 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  statCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, minWidth: '30%', flexGrow: 1 },
  statNum: { color: colors.text, fontSize: 20, fontWeight: '700', fontFamily: 'monospace' },
  statLbl: { color: colors.textDim, fontSize: 10.5, marginTop: 2 },
  sectionTitle: { color: colors.textDim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 10, fontWeight: '600' },
  shelterRow: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, marginBottom: 8 },
  rowTitle: { color: colors.text, fontSize: 13 },
  rowMeta: { color: colors.textFaint, fontSize: 10.5, fontFamily: 'monospace', marginTop: 2 },
  pctBarTrack: { height: 6, backgroundColor: colors.panel, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  pctBarFill: { height: '100%', backgroundColor: colors.amber },
  empty: { color: colors.textFaint, fontSize: 12, fontFamily: 'monospace' },
  incRow: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, marginBottom: 8 },
  thumb: { width: 40, height: 40, borderRadius: 4 },
  logRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  logText: { color: colors.textDim, fontSize: 10.5, fontFamily: 'monospace', flex: 1 },
  logOutcome: { fontSize: 10.5, fontFamily: 'monospace', marginLeft: 8 },
});
