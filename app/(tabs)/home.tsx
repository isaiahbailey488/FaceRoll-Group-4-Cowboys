import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import ActivityItem from '../../components/ActivityItem';
import FaceRollLogo from '../../components/FaceRollLogo';
import Colors from '../../constants/Colors';
import { getCurrentUser, getUserProfile, UserProfile, fallbackNameFromEmail } from '../../services/auth';
import { getRecentActivity, formatAttendanceDate, AttendanceRecord } from '../../services/attendance';


export default function HomeScreen() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activity, setActivity] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const getGreeting = (): string => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning,';
    if (hour < 17) return 'Good Afternoon,';
    return 'Good Evening,';
  };

  const loadData = useCallback(async () => {
    try {
      const user = getCurrentUser();
      if (!user) return;

      const [profileResult, activityResult] = await Promise.allSettled([
        getUserProfile(user.uid),
        getRecentActivity(user.uid, 10),
      ]);

      if (profileResult.status === 'fulfilled') {
        setProfile(profileResult.value);
      } else if (__DEV__) {
        const e: any = profileResult.reason;
        console.warn('[home] profile load failed:', e?.code || e?.message);
      }

      if (activityResult.status === 'fulfilled') {
        setActivity(activityResult.value);
      } else if (__DEV__) {
        const e: any = activityResult.reason;
        console.warn('[home] activity load failed:', e?.code || e?.message);
      }
    } catch (error: any) {
      if (__DEV__) {
        console.warn('[home] data load skipped:', error?.code || error?.message || error);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  const handleCheckIn = () => {
    router.push('/attendance-checkin');
  };

  const currentUser = getCurrentUser();
  const firstName =
    (profile?.fname && profile.fname.trim()) ||
    (profile?.displayName && profile.displayName.split(' ')[0]) ||
    fallbackNameFromEmail(currentUser?.email || '').firstName;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.navy}
            colors={[Colors.navy]}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.logoWrap}>
            <FaceRollLogo size={72} showText={false} />
          </View>

          <View style={styles.greetingBlock}>
            <Text style={styles.greetingText}>{getGreeting()}</Text>
            <Text style={styles.nameText} numberOfLines={1}>{firstName}</Text>
          </View>

          <TouchableOpacity
            style={styles.avatarButton}
            onPress={() => router.push('/(tabs)/profile')}
            activeOpacity={0.7}
          >
            <Ionicons name="person-circle-outline" size={44} color={Colors.navy} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.checkInButton}
          onPress={handleCheckIn}
          activeOpacity={0.85}
        >
          <Ionicons name="scan-outline" size={22} color={Colors.white} style={styles.checkInIcon} />
          <Text style={styles.checkInText}>Check-In</Text>
        </TouchableOpacity>

        <View style={styles.activitySection}>
          <Text style={styles.sectionTitle}>Recent Activity</Text>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={Colors.navy} />
              <Text style={styles.loadingText}>Loading activity...</Text>
            </View>
          ) : activity.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="calendar-outline" size={48} color={Colors.inputBorder} />
              <Text style={styles.emptyTitle}>No Activity Yet</Text>
              <Text style={styles.emptySubtitle}>
                Your attendance records will appear here after your first check-in.
              </Text>
            </View>
          ) : (
            activity.map((record) => (
              <ActivityItem
                key={record.id}
                courseName={record.courseName ?? record.courseId}
                date={formatAttendanceDate(record.time)}
                status={record.status}
              />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.white,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 28,
  },
  logoWrap: {
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  greetingBlock: {
    flex: 1,
  },
  greetingText: {
    fontSize: 16,
    color: Colors.textSecondary,
    fontWeight: '400',
    marginBottom: 2,
  },
  nameText: {
    fontSize: 26,
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  avatarButton: {
    marginLeft: 12,
    marginTop: 2,
  },

  checkInButton: {
    backgroundColor: Colors.buttonDark,
    borderRadius: 12,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  checkInIcon: {
    marginRight: 10,
  },
  checkInText: {
    color: Colors.white,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  activitySection: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 16,
    letterSpacing: -0.3,
  },

  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 20,
  },
  loadingText: {
    marginLeft: 10,
    color: Colors.textSecondary,
    fontSize: 14,
  },

  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginTop: 12,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 13,
    color: Colors.inputPlaceholder,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 20,
  },
});
