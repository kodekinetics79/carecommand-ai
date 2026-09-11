import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet,
  Text, TextInput, View, type KeyboardTypeOptions, type StyleProp, type ViewStyle,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, radius, shadow, spacing } from './theme';

export function Screen({ children, scroll = true, refreshing, onRefresh }: {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : <View style={styles.screenContent}>{children}</View>;
  return <SafeAreaView style={styles.safe}><StatusBar style="light" />{body}</SafeAreaView>;
}

export function Brand({ eyebrow }: { eyebrow?: string }) {
  return <View style={styles.brandWrap}>
    <View style={styles.brandMark}><Text style={styles.brandMarkText}>C</Text></View>
    <View style={styles.flex}>
      <Text style={styles.brand}>CareCommand</Text>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
    </View>
  </View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return <View style={styles.sectionHead}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
  </View>;
}

export function Field({ label, value, onChangeText, placeholder, secureTextEntry, keyboardType = 'default', autoCapitalize = 'none', multiline }: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
}) {
  return <View style={styles.fieldWrap}>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      style={[styles.input, multiline && styles.inputMultiline]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      accessibilityLabel={label}
    />
  </View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, busy }: {
  title: string;
  onPress(): void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  return <Pressable
    onPress={onPress}
    disabled={disabled || busy}
    style={({ pressed }) => [
      styles.button,
      variant === 'secondary' && styles.buttonSecondary,
      variant === 'ghost' && styles.buttonGhost,
      variant === 'danger' && styles.buttonDanger,
      (disabled || busy) && styles.buttonDisabled,
      pressed && styles.pressed,
    ]}
    accessibilityRole="button"
  >
    {busy ? <ActivityIndicator color={variant === 'primary' ? colors.bg : colors.text} /> :
      <Text style={[styles.buttonText, variant === 'primary' && styles.buttonTextPrimary]}>{title}</Text>}
  </Pressable>;
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'blue' }) {
  return <View style={[
    styles.pill,
    tone === 'success' && styles.pillSuccess,
    tone === 'warning' && styles.pillWarning,
    tone === 'danger' && styles.pillDanger,
    tone === 'blue' && styles.pillBlue,
  ]}><Text style={styles.pillText}>{text.replaceAll('_', ' ')}</Text></View>;
}

export function Segmented({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }) {
  return <View style={styles.segmented}>
    {options.map(option => <Pressable
      key={option.value}
      onPress={() => onChange(option.value)}
      style={[styles.segment, option.value === value && styles.segmentActive]}
    ><Text style={[styles.segmentText, option.value === value && styles.segmentTextActive]}>{option.label}</Text></Pressable>)}
  </View>;
}

export function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <Card style={styles.metric}>
    <Text style={styles.metricValue}>{value}</Text>
    <Text style={styles.metricLabel}>{label}</Text>
    {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
  </Card>;
}

export function Message({ text, error }: { text: string; error?: boolean }) {
  return <View style={[styles.message, error && styles.messageError]}>
    <Text style={styles.messageText}>{text}</Text>
  </View>;
}

export function Loading({ label = 'Loading your workspace…' }: { label?: string }) {
  return <SafeAreaView style={styles.loading}><StatusBar style="light" /><Brand /><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.mutedCenter}>{label}</Text></SafeAreaView>;
}

export function formatDateTime(value?: string | null) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function formatMoney(value: number, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value || 0);
}

export const ui = StyleSheet.create({
  title: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
  h2: { color: colors.text, fontSize: 20, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  gapSm: { gap: spacing.sm }, gapMd: { gap: spacing.md }, gapLg: { gap: spacing.lg },
  flex: { flex: 1 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  screenContent: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg, backgroundColor: colors.bg },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  brandMark: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: colors.bg, fontWeight: '900', fontSize: 22 },
  brand: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  eyebrow: { color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.2, marginTop: 1 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, ...shadow },
  sectionHead: { gap: 3 },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  sectionSubtitle: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  fieldWrap: { gap: spacing.xs }, label: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  input: { minHeight: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, color: colors.text, paddingHorizontal: spacing.md, fontSize: 16 },
  inputMultiline: { minHeight: 96, paddingTop: spacing.md },
  button: { minHeight: 50, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  buttonSecondary: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: 'rgba(255,139,139,0.12)', borderWidth: 1, borderColor: 'rgba(255,139,139,0.35)' },
  buttonDisabled: { opacity: 0.5 }, pressed: { opacity: 0.82, transform: [{ scale: 0.995 }] },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '800' }, buttonTextPrimary: { color: colors.bg },
  pill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.border },
  pillSuccess: { backgroundColor: 'rgba(112,224,163,0.12)', borderColor: 'rgba(112,224,163,0.3)' },
  pillWarning: { backgroundColor: 'rgba(245,199,106,0.12)', borderColor: 'rgba(245,199,106,0.3)' },
  pillDanger: { backgroundColor: 'rgba(255,139,139,0.12)', borderColor: 'rgba(255,139,139,0.3)' },
  pillBlue: { backgroundColor: 'rgba(125,183,255,0.12)', borderColor: 'rgba(125,183,255,0.3)' },
  pillText: { color: colors.text, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.md, padding: 4, borderWidth: 1, borderColor: colors.border },
  segment: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surface2 }, segmentText: { color: colors.muted, fontWeight: '700' }, segmentTextActive: { color: colors.text },
  metric: { flex: 1, minWidth: 145, gap: 3 }, metricValue: { color: colors.text, fontSize: 27, fontWeight: '900' }, metricLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' }, metricHint: { color: colors.primary, fontSize: 11, marginTop: 2 },
  message: { padding: spacing.md, borderRadius: radius.md, backgroundColor: 'rgba(125,183,255,0.1)', borderWidth: 1, borderColor: 'rgba(125,183,255,0.25)' },
  messageError: { backgroundColor: 'rgba(255,139,139,0.1)', borderColor: 'rgba(255,139,139,0.25)' }, messageText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  loading: { flex: 1, backgroundColor: colors.bg, padding: spacing.xl, justifyContent: 'center', gap: spacing.xl }, mutedCenter: { color: colors.muted, textAlign: 'center' },
});
