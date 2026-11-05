const Colors = {
  // Primary brand colors
  navy: '#2C5282',
  navyLight: '#2C5282',
  green: '#2E7D42',

  // Button colors
  buttonDark: '#2C5282',
  buttonText: '#FFFFFF',

  // Background colors
  white: '#FFFFFF',
  surface: '#FCFCFD',
  offWhite: '#F6F7F9',
  cameraBackground: '#000000',

  // Text colors
  textPrimary: '#111827',
  textSecondary: '#52647A',
  textLink: '#2C5282',

  // Input / Form colors
  inputBackground: '#FCFCFD',
  inputBorder: '#D1D5DB',
  inputBorderFocus: '#2C5282',
  inputText: '#111827',
  inputPlaceholder: '#9CA3AF',

  // Status colors
  present: '#2E7D42',
  presentBackground: '#EDF5EF',
  late: '#946200',
  lateBackground: '#FFF6DE',
  absent: '#B42318',
  absentBackground: '#FDEDEC',

  // Camera UI colors
  cameraGuide: '#FFFFFF',
  cameraButton: '#FFFFFF',
  cameraButtonInner: '#000000',
  cameraOverlay: 'rgba(0,0,0,0.4)',
  // Lighter feedback colors stay readable on the dark camera preview.
  cameraSuccess: '#8FD6A0',
  cameraError: '#FF8A8A',

  // Toggle / Activity item
  toggleActive: '#2C5282',
  toggleInactive: '#D1D5DB',

  // Divider
  divider: '#E5E7EB',

  // Error
  error: '#B42318',
  errorBackground: '#FEF2F2',
};

// Semantic aliases keep the approved Home design on the shared mobile palette.
export const HomeColors = {
  button: Colors.buttonDark,
  green: Colors.green,
  surface: Colors.surface,
  background: Colors.offWhite,
  border: Colors.divider,
  muted: Colors.textSecondary,
  presentBackground: Colors.presentBackground,
  late: Colors.late,
  lateBackground: Colors.lateBackground,
  absent: Colors.absent,
  absentBackground: Colors.absentBackground,
};

export default Colors;
