import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../../constants/Colors';
import {
  getCurrentUser,
  fallbackNameFromEmail,
  getUserProfile,
  logoutUser,
  resetPassword,
  updateOptOut,
  UserProfile,
} from '../../services/auth';

export default function ProfileScreen() {
  const router = useRouter();
  const authUser = getCurrentUser();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [updatingOptOut, setUpdatingOptOut] = useState(false);

  const loadProfile = useCallback(async () => {
    try {
      const user = getCurrentUser();
      if (!user) return;
      const userProfile = await getUserProfile(user.uid);
      setProfile(userProfile);
    } catch (error: any) {
      if (__DEV__) {
        console.warn('[profile] load skipped:', error?.code || error?.message || error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const handleOptOutToggle = async (value: boolean) => {
    setUpdatingOptOut(true);
    try {
      const user = getCurrentUser();
      if (!user) {
        Alert.alert('Not Signed In', 'Please sign in again.');
        return;
      }
      await updateOptOut(user.uid, value);
      setProfile((prev) => (prev ? { ...prev, optOutFlag: value } : prev));
    } catch (err: any) {
      if (err?.code === 'firestore/rules-not-deployed') {
        Alert.alert(
          'Firestore Rules Not Deployed',
          'Your opt-out preference could not be saved. Deploy firestore.rules to your Firebase project (see FIRESTORE_SETUP.md) and try again.'
        );
      } else {
        Alert.alert('Error', 'Could not update your preference. Please try again.');
      }
    } finally {
      setUpdatingOptOut(false);
    }
  };

  const handleEnrollPress = () => {
    const alreadyEnrolled = Boolean(profile?.faceEnrolled);

    if (!alreadyEnrolled) {
      router.push('/face-enrollment');
      return;
    }

    Alert.alert(
      'Re-enroll Face',
      'This will replace your current facial data. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => router.push('/face-enrollment'),
        },
      ]
    );
  };

  const handleChangePassword = () => {
    const email = profile?.email || authUser?.email;

    if (!email) {
      Alert.alert(
        'Change Password',
        'We couldn\'t find an email for your account. Please sign out and sign back in, then try again.'
      );
      return;
    }

    Alert.alert(
      'Change Password',
      `We'll send a password reset link to:\n\n${email}\n\nFollow the link in that email to set a new password.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Email',
          onPress: async () => {
            try {
              await resetPassword(email);
              Alert.alert(
                'Email Sent',
                `A password reset link has been sent to ${email}. Check your inbox (and spam folder).`
              );
            } catch (err: any) {
              const code = err?.code || '';
              let msg = 'Could not send reset email. Please try again.';
              if (code === 'auth/invalid-email') msg = 'That email address is not valid.';
              else if (code === 'auth/user-not-found') msg = 'No account was found for that email.';
              else if (code === 'auth/too-many-requests') {
                msg = 'Too many reset attempts. Please wait a few minutes and try again.';
              } else if (err?.message) {
                msg = err.message;
              }
              Alert.alert('Error', msg);
            }
          },
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          setLoggingOut(true);
          try {
            await logoutUser();
            router.replace('/(auth)/login');
          } catch {
            Alert.alert('Error', 'Could not sign out. Please try again.');
            setLoggingOut(false);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.navy} />
        </View>
      </SafeAreaView>
    );
  }

  const emailName = fallbackNameFromEmail(authUser?.email || '');

  const displayName =
    (profile?.displayName && profile.displayName.trim()) ||
    (profile?.fullName && profile.fullName.trim()) ||
    `${emailName.firstName} ${emailName.lastName}`.trim();
  const displayEmail = profile?.email || authUser?.email || '';
  const displayStudentId = profile?.studentId || authUser?.uid || '';
  const firstInitial = (profile?.fname || emailName.firstName).charAt(0);
  const lastInitial = (profile?.lname || emailName.lastName).charAt(0);
  const initials = `${firstInitial}${lastInitial}`.toUpperCase() || '?';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <Text style={styles.pageTitle}>Profile & Settings</Text>
          <TouchableOpacity
            style={styles.homeNavButton}
            onPress={() => router.replace('/(tabs)/home')}
            activeOpacity={0.8}
          >
            <Ionicons name="home-outline" size={22} color={Colors.navy} />
          </TouchableOpacity>
        </View>

        <View style={styles.profileCard}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitials}>{initials}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{displayName}</Text>
            <Text style={styles.profileEmail}>{displayEmail}</Text>
            {displayStudentId ? (
              <Text style={styles.profileStudentId}>ID: {displayStudentId}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Facial Recognition</Text>

          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons
                name={profile?.faceEnrolled ? 'checkmark-circle' : 'alert-circle-outline'}
                size={22}
                color={profile?.faceEnrolled ? Colors.present : Colors.late}
                style={styles.settingIcon}
              />
              <View>
                <Text style={styles.settingLabel}>Face Enrollment</Text>
                <Text style={styles.settingSubLabel}>
                  {profile?.faceEnrolled ? 'Enrolled — ready for check-in' : 'Not enrolled yet'}
                </Text>
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={styles.enrollButton}
            onPress={handleEnrollPress}
            activeOpacity={0.85}
          >
            <Ionicons name="camera-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
            <Text style={styles.enrollButtonText}>
              {profile?.faceEnrolled ? 'Re-enroll Face' : 'Enroll Face'}
            </Text>
          </TouchableOpacity>

          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Ionicons
                name="eye-off-outline"
                size={22}
                color={Colors.textSecondary}
                style={styles.settingIcon}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.settingLabel}>Opt Out of Facial Recognition</Text>
                <Text style={styles.settingSubLabel}>
                  Your attendance will be marked manually by your instructor.
                </Text>
              </View>
            </View>
            {updatingOptOut ? (
              <ActivityIndicator size="small" color={Colors.navy} />
            ) : (
              <Switch
                value={profile?.optOutFlag ?? false}
                onValueChange={handleOptOutToggle}
                trackColor={{ false: Colors.inputBorder, true: Colors.navyLight }}
                thumbColor={Colors.white}
              />
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account Settings</Text>

          <TouchableOpacity
            style={styles.settingRow}
            activeOpacity={0.8}
            onPress={handleChangePassword}
          >
            <View style={styles.settingLeft}>
              <Ionicons
                name="key-outline"
                size={22}
                color={Colors.textSecondary}
                style={styles.settingIcon}
              />
              <View>
                <Text style={styles.settingLabel}>Change Password</Text>
                <Text style={styles.settingSubLabel}>
                  Update your account password
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.inputPlaceholder} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.logoutButton, loggingOut && styles.buttonDisabled]}
          onPress={handleLogout}
          disabled={loggingOut}
          activeOpacity={0.85}
        >
          {loggingOut ? (
            <ActivityIndicator color={Colors.error} />
          ) : (
            <>
              <Ionicons name="log-out-outline" size={20} color={Colors.error} style={{ marginRight: 8 }} />
              <Text style={styles.logoutText}>Sign Out</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.versionText}>FaceRoll v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.offWhite,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  homeNavButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },

  profileCard: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  avatarCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.navy,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  avatarInitials: {
    color: Colors.white,
    fontSize: 22,
    fontWeight: '700',
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  profileEmail: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 2,
  },
  profileStudentId: {
    fontSize: 12,
    color: Colors.inputPlaceholder,
  },

  section: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    marginBottom: 4,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  settingIcon: {
    marginRight: 12,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  settingSubLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 16,
  },

  enrollButton: {
    backgroundColor: Colors.navy,
    borderRadius: 10,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
  enrollButtonText: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: '600',
  },

  logoutButton: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    paddingVertical: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: Colors.error,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  logoutText: {
    color: Colors.error,
    fontSize: 16,
    fontWeight: '600',
  },

  versionText: {
    textAlign: 'center',
    fontSize: 12,
    color: Colors.inputPlaceholder,
    marginTop: 8,
  },
});
