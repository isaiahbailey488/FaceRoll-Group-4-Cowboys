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
import Colors, { HomeColors } from '../../constants/Colors';
import { getCurrentUser, getStudentDisplayName, getUserProfile, UserProfile } from '../../services/auth';
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
  const firstName = getStudentDisplayName(profile, currentUser?.email).split(' ')[0];

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
            tintColor={HomeColors.button}
            colors={[HomeColors.button]}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.logoWrap}>
            <FaceRollLogo size={48} showText={false} />
          </View>

          <View style={styles.greetingBlock}>
            <Text style={styles.brandName}>FaceRoll</Text>
            <Text style={styles.brandSubtitle}>Student workspace</Text>
          </View>

          <TouchableOpacity
            style={styles.avatarButton}
            onPress={() => router.push('/(tabs)/profile')}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open profile and settings"
          >
            <Ionicons name="person-outline" size={22} color={HomeColors.button} />
          </TouchableOpacity>
        </View>

        <View style={styles.welcomeBlock}>
          <Text style={styles.greetingText}>{getGreeting()}</Text>
          <Text style={styles.nameText}>{firstName}</Text>
          <Text style={styles.pageSubtitle}>Your attendance, all in one place.</Text>
        </View>

        <View style={styles.checkInCard}>
          <View style={styles.cardHeading}>
            <View style={styles.scanIcon}>
              <Ionicons name="scan-outline" size={26} color={HomeColors.button} />
            </View>
            <View style={styles.cardHeadingText}>
              <Text style={styles.cardTitle}>Ready for class?</Text>
              <Text style={styles.cardDescription}>Check in to an active session.</Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.checkInButton}
            onPress={handleCheckIn}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <Ionicons name="scan-outline" size={22} color={Colors.white} style={styles.checkInIcon} />
            <Text style={styles.checkInText}>Check-In</Text>
            <Ionicons name="arrow-forward" size={20} color={Colors.white} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.joinButton}
          onPress={() => router.push('../join-course')}
          accessibilityRole="button"
          activeOpacity={0.8}
        >
          <View style={styles.joinIcon}>
            <Ionicons name="qr-code-outline" size={22} color={HomeColors.button} />
          </View>
          <View style={styles.cardHeadingText}>
            <Text style={styles.joinTitle}>Join a Course</Text>
            <Text style={styles.cardDescription}>Scan an invitation or enter a code</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={HomeColors.button} />
        </TouchableOpacity>

        <View style={styles.activitySection}>
          <Text style={styles.sectionTitle}>Recent Activity</Text>
          <View style={styles.legend}>
            <Text style={[styles.legendText, { color: HomeColors.green }]}>✓ Present</Text>
            <Text style={[styles.legendText, { color: HomeColors.late }]}>L Late</Text>
            <Text style={[styles.legendText, { color: HomeColors.absent }]}>✗ Absent</Text>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={HomeColors.button} />
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
    backgroundColor: HomeColors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: HomeColors.border,
  },
  logoWrap: {
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  greetingBlock: {
    flex: 1,
  },
  brandName: {
    fontSize: 20,
    fontWeight: '700',
    color: HomeColors.green,
  },
  brandSubtitle: {
    fontSize: 12,
    color: HomeColors.muted,
    marginTop: 3,
  },
  welcomeBlock: {
    marginBottom: 22,
  },
  greetingText: {
    fontSize: 16,
    color: HomeColors.muted,
    fontWeight: '400',
    marginBottom: 2,
  },
  nameText: {
    fontSize: 30,
    fontWeight: '700',
    color: HomeColors.green,
    letterSpacing: -0.5,
  },
  avatarButton: {
    marginLeft: 12,
    minWidth: 48,
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: HomeColors.surface,
    borderWidth: 1,
    borderColor: HomeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageSubtitle: {
    fontSize: 14,
    color: HomeColors.muted,
    marginTop: 8,
    lineHeight: 21,
  },
  checkInCard: {
    backgroundColor: HomeColors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: HomeColors.border,
    padding: 18,
    marginBottom: 14,
  },
  cardHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  scanIcon: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: HomeColors.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  cardHeadingText: {
    flex: 1,
  },
  cardTitle: {
    color: HomeColors.green,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 5,
  },
  cardDescription: {
    color: HomeColors.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  checkInButton: {
    backgroundColor: HomeColors.button,
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkInIcon: {
    marginRight: 10,
  },
  checkInText: {
    flex: 1,
    color: Colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  joinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: HomeColors.surface,
    borderWidth: 1,
    borderColor: HomeColors.border,
    borderRadius: 14,
    marginBottom: 24,
  },
  joinIcon: {
    marginRight: 14,
  },
  joinTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: HomeColors.button,
    marginBottom: 4,
  },

  activitySection: {
    backgroundColor: HomeColors.surface,
    borderWidth: 1,
    borderColor: HomeColors.border,
    borderRadius: 16,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: HomeColors.green,
    marginBottom: 12,
    letterSpacing: -0.3,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 16,
  },
  legendText: {
    fontSize: 12,
    fontWeight: '600',
  },

  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 20,
  },
  loadingText: {
    marginLeft: 10,
    color: HomeColors.muted,
    fontSize: 14,
  },

  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: HomeColors.muted,
    marginTop: 12,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 13,
    color: HomeColors.muted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 20,
  },
});
