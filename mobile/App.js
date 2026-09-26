import React, { useEffect, useState, useCallback } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

import LoginScreen from './screens/LoginScreen';
import SurvivorScreen from './screens/SurvivorScreen';
import VolunteerScreen from './screens/VolunteerScreen';
import AuthorityScreen from './screens/AuthorityScreen';
import { flushQueue, queueLength } from './lib/offlineQueue';
import { colors } from './lib/theme';

const SESSION_KEY = 'drrt_session_v1';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null); // {token, username, full_name, role}
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem(SESSION_KEY);
      if (raw) setSession(JSON.parse(raw));
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = !!state.isConnected && state.isInternetReachable !== false;
      setOnline(isOnline);
      if (isOnline && session) doFlush();
    });
    return () => unsub();
  }, [session]);

  const refreshPending = useCallback(async () => setPending(await queueLength()), []);

  useEffect(() => {
    refreshPending();
    const t = setInterval(refreshPending, 5000);
    return () => clearInterval(t);
  }, [refreshPending]);

  const doFlush = useCallback(async () => {
    if (!session) return;
    await flushQueue(session.token, () => {});
    await refreshPending();
  }, [session, refreshPending]);

  const handleLogin = async (data) => {
    const s = { token: data.access_token, username: data.username, full_name: data.full_name, role: data.role };
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem(SESSION_KEY);
    setSession(null);
  };

  if (booting) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.amber} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      {!session ? (
        <LoginScreen onLogin={handleLogin} />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.statusBar}>
            <View style={[styles.dot, { backgroundColor: online ? colors.safe : colors.danger }]} />
            <Text style={styles.statusText}>{online ? 'ONLINE' : 'OFFLINE — storing locally'}</Text>
            {pending > 0 && <Text style={styles.pendingPill}>{pending} pending</Text>}
            <Text style={styles.who}>{session.full_name} · {session.role}</Text>
          </View>

          {session.role === 'survivor' && (
            <SurvivorScreen session={session} online={online} onLogout={handleLogout} onQueueChange={refreshPending} />
          )}
          {session.role === 'volunteer' && (
            <VolunteerScreen session={session} online={online} onLogout={handleLogout} onQueueChange={refreshPending} />
          )}
          {session.role === 'authority' && (
            <AuthorityScreen session={session} online={online} onLogout={handleLogout} />
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.textDim, fontSize: 11, fontFamily: 'monospace' },
  pendingPill: {
    color: colors.amber, fontSize: 10, fontFamily: 'monospace', borderWidth: 1, borderColor: colors.amber,
    paddingHorizontal: 6, borderRadius: 10, marginLeft: 4,
  },
  who: { marginLeft: 'auto', color: colors.textFaint, fontSize: 10, fontFamily: 'monospace' },
});
