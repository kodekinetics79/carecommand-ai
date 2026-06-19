import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../server/generated/prisma/client';
import { generatePasswordHash } from '../server/lib/security';
import { evaluateSeverity } from '../server/lib/monitoring';
import { normalizeWebhook } from '../server/lib/connectedCare/deviceAdapters';

// Production guard: never load demo/seed data into a production database by
// accident. Explicit opt-in (ALLOW_PROD_SEED=true) is required.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
  console.error('[seed] Refusing to seed demo data in production. Set ALLOW_PROD_SEED=true to override.');
  process.exit(1);
}

const tenantId = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const userId = process.env.DEV_USER_ID ?? '22222222-2222-4222-8222-222222222222';
const branchId = '33333333-3333-4333-8333-333333333333';
const patientId = '44444444-4444-4444-8444-444444444444';
const providerLoginEmail = 'sarah.mitchell@carecommand.local';
const providerLoginPassword = 'Provider123!';

// Seed runs as the owner/superuser (it must bypass RLS to write across tenants
// and into RLS-enabled pilot tables). Prefer DATABASE_MIGRATION_URL when set.
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }),
});

async function ensureClinicAccess(userId: string, branchId: string, isPrimary = false) {
  const existing = await db.userClinicAccess.findFirst({
    where: { tenantId, userId, branchId },
  });
  if (!existing) {
    await db.userClinicAccess.create({
      data: {
        tenantId,
        userId,
        branchId,
        isPrimary,
      },
    });
  } else if (isPrimary && !existing.isPrimary) {
    await db.userClinicAccess.update({
      where: { id: existing.id },
      data: { isPrimary: true },
    });
  }
}

await db.tenant.upsert({
  where: { id: tenantId },
  update: {},
  create: { id: tenantId, name: 'Harley Street Medical Group', slug: 'harley-street-medical' },
});

await db.branch.upsert({
  where: { id: branchId },
  update: {},
  create: { id: branchId, tenantId, name: 'Downtown Medical Centre', location: '42 Harley Street, London' },
});

await db.user.upsert({
  where: { id: userId },
  update: {
    tenantId,
    email: 'admin@carecommand.ai',
    displayName: 'Olivia Bennett',
    role: 'OWNER',
    passwordHash: await generatePasswordHash('ChangeMe123!'),
    active: true,
  },
  create: {
    id: userId,
    tenantId,
    email: 'admin@carecommand.ai',
    displayName: 'Olivia Bennett',
    role: 'OWNER',
    passwordHash: await generatePasswordHash('ChangeMe123!'),
  },
});

for (const branch of [
  { id: branchId, name: 'Downtown Medical Centre', location: '42 Harley Street, London' },
  { id: '66666666-6666-4666-8666-666666666666', name: 'Northgate Wellness Studio', location: '18 Finchley Road, London' },
  { id: '77777777-7777-4777-8777-777777777777', name: 'Southbank Dental House', location: '7 Southbank Place, London' },
  { id: '88888888-8888-4888-8888-888888888888', name: 'Westside Family Clinic', location: '91 Uxbridge Road, London' },
]) {
  await db.branch.upsert({
    where: { id: branch.id },
    update: {},
    create: { id: branch.id, tenantId, name: branch.name, location: branch.location },
  });
}

for (const branchAccessId of [branchId, '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888']) {
  await ensureClinicAccess(userId, branchAccessId, branchAccessId === branchId);
}

const providerSeeds = [
  { email: 'sarah.mitchell@carecommand.local', displayName: 'Dr. Sarah Mitchell', branchId, specialty: 'Family Medicine', utilization: 92, appointmentsToday: 11, appointmentsThisMonth: 198, rating: 4.9, reviewCount: 142, revenueThisMonth: 38400, repeatVisitRate: 78, followUpRate: 88 },
  { email: 'james.okafor@carecommand.local', displayName: 'Dr. James Okafor', branchId, specialty: 'Dermatology', utilization: 88, appointmentsToday: 10, appointmentsThisMonth: 172, rating: 4.8, reviewCount: 98, revenueThisMonth: 44200, repeatVisitRate: 71, followUpRate: 82 },
  { email: 'priya.sharma@carecommand.local', displayName: 'Dr. Priya Sharma', branchId, specialty: 'Pediatrics', utilization: 84, appointmentsToday: 9, appointmentsThisMonth: 160, rating: 4.9, reviewCount: 201, revenueThisMonth: 28900, repeatVisitRate: 85, followUpRate: 91 },
  { email: 'ahmed.hassan@carecommand.local', displayName: 'Dr. Ahmed Hassan', branchId, specialty: 'Internal Medicine', utilization: 79, appointmentsToday: 8, appointmentsThisMonth: 144, rating: 4.7, reviewCount: 67, revenueThisMonth: 31200, repeatVisitRate: 68, followUpRate: 76 },
  { email: 'emma.clarke@carecommand.local', displayName: 'Dr. Emma Clarke', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Family Medicine', utilization: 65, appointmentsToday: 8, appointmentsThisMonth: 128, rating: 4.6, reviewCount: 54, revenueThisMonth: 24100, repeatVisitRate: 62, followUpRate: 71 },
  { email: 'raj.patel@carecommand.local', displayName: 'Dr. Raj Patel', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Physiotherapy', utilization: 58, appointmentsToday: 9, appointmentsThisMonth: 112, rating: 4.7, reviewCount: 89, revenueThisMonth: 19800, repeatVisitRate: 74, followUpRate: 84 },
  { email: 'lisa.wong@carecommand.local', displayName: 'Dr. Lisa Wong', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Wellness & Nutrition', utilization: 61, appointmentsToday: 7, appointmentsThisMonth: 98, rating: 4.8, reviewCount: 43, revenueThisMonth: 21300, repeatVisitRate: 69, followUpRate: 79 },
  { email: 'marcus.bell@carecommand.local', displayName: 'Dr. Marcus Bell', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dental', utilization: 81, appointmentsToday: 12, appointmentsThisMonth: 210, rating: 4.8, reviewCount: 176, revenueThisMonth: 52100, repeatVisitRate: 76, followUpRate: 87 },
  { email: 'aisha.nwosu@carecommand.local', displayName: 'Dr. Aisha Nwosu', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dermatology', utilization: 76, appointmentsToday: 10, appointmentsThisMonth: 158, rating: 4.9, reviewCount: 121, revenueThisMonth: 41400, repeatVisitRate: 82, followUpRate: 90 },
  { email: 'tom.eriksson@carecommand.local', displayName: 'Dr. Tom Eriksson', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dental', utilization: 68, appointmentsToday: 7, appointmentsThisMonth: 132, rating: 4.6, reviewCount: 88, revenueThisMonth: 34200, repeatVisitRate: 65, followUpRate: 73 },
  { email: 'fatima.alrashid@carecommand.local', displayName: 'Dr. Fatima Al-Rashid', branchId: '88888888-8888-4888-8888-888888888888', specialty: 'Family Medicine', utilization: 55, appointmentsToday: 10, appointmentsThisMonth: 104, rating: 4.7, reviewCount: 39, revenueThisMonth: 22800, repeatVisitRate: 58, followUpRate: 68 },
  { email: 'nathan.brooks@carecommand.local', displayName: 'Dr. Nathan Brooks', branchId: '88888888-8888-4888-8888-888888888888', specialty: 'Physiotherapy', utilization: 49, appointmentsToday: 7, appointmentsThisMonth: 88, rating: 4.5, reviewCount: 28, revenueThisMonth: 16400, repeatVisitRate: 52, followUpRate: 62 },
] as const;

for (const provider of providerSeeds) {
  const user = await db.user.findFirst({
    where: {
      tenantId,
      email: provider.email,
    },
  });
  const providerUser = user ?? await db.user.create({
    data: {
      tenantId,
      branchId: provider.branchId,
      email: provider.email,
      displayName: provider.displayName,
      role: 'PROVIDER',
    },
  });

  if (provider.email === providerLoginEmail) {
    await db.user.update({
      where: { id: providerUser.id },
      data: {
        passwordHash: await generatePasswordHash(providerLoginPassword),
        active: true,
      },
    });
  }

  await ensureClinicAccess(providerUser.id, provider.branchId, true);

  const existingProfile = await db.providerProfile.findFirst({
    where: {
      tenantId,
      userId: providerUser.id,
    },
  });
  if (!existingProfile) {
    await db.providerProfile.create({
      data: {
        tenantId,
        branchId: provider.branchId,
        userId: providerUser.id,
        specialty: provider.specialty,
        utilization: provider.utilization,
        appointmentsToday: provider.appointmentsToday,
        appointmentsThisMonth: provider.appointmentsThisMonth,
        rating: provider.rating,
        reviewCount: provider.reviewCount,
        revenueThisMonth: provider.revenueThisMonth,
        repeatVisitRate: provider.repeatVisitRate,
        followUpRate: provider.followUpRate,
      },
    });
  }
}

const staffSeeds = [
  { email: 'tanya.obi@carecommand.local', name: 'Tanya Obi', roleTitle: 'Senior Receptionist', branchId, responseTime: 3.8, missedCalls: 4, followUpRate: 88, bookingConversionRate: 72, tasksCompleted: 42, tasksPending: 5, patientFeedbackScore: 4.7 },
  { email: 'aaron.mensah@carecommand.local', name: 'Aaron Mensah', roleTitle: 'Receptionist', branchId, responseTime: 5.2, missedCalls: 9, followUpRate: 74, bookingConversionRate: 61, tasksCompleted: 31, tasksPending: 8, patientFeedbackScore: 4.3 },
  { email: 'blessing.eze@carecommand.local', name: 'Blessing Eze', roleTitle: 'Care Coordinator', branchId, responseTime: 4.1, missedCalls: 2, followUpRate: 94, bookingConversionRate: 81, tasksCompleted: 58, tasksPending: 3, patientFeedbackScore: 4.9 },
  { email: 'jake.williams@carecommand.local', name: 'Jake Williams', roleTitle: 'Receptionist', branchId: '66666666-6666-4666-8666-666666666666', responseTime: 6.7, missedCalls: 14, followUpRate: 58, bookingConversionRate: 49, tasksCompleted: 24, tasksPending: 12, patientFeedbackScore: 3.9 },
  { email: 'nia.asante@carecommand.local', name: 'Nia Asante', roleTitle: 'Senior Receptionist', branchId: '66666666-6666-4666-8666-666666666666', responseTime: 4.9, missedCalls: 6, followUpRate: 79, bookingConversionRate: 66, tasksCompleted: 38, tasksPending: 6, patientFeedbackScore: 4.5 },
  { email: 'mia.larsson@carecommand.local', name: 'Mia Larsson', roleTitle: 'Receptionist', branchId: '77777777-7777-4777-8777-777777777777', responseTime: 3.2, missedCalls: 3, followUpRate: 91, bookingConversionRate: 78, tasksCompleted: 47, tasksPending: 2, patientFeedbackScore: 4.8 },
  { email: 'leo.adeyemi@carecommand.local', name: 'Leo Adeyemi', roleTitle: 'Care Coordinator', branchId: '77777777-7777-4777-8777-777777777777', responseTime: 4.4, missedCalls: 5, followUpRate: 86, bookingConversionRate: 73, tasksCompleted: 52, tasksPending: 4, patientFeedbackScore: 4.6 },
  { email: 'sara.haddad@carecommand.local', name: 'Sara Haddad', roleTitle: 'Receptionist', branchId: '88888888-8888-4888-8888-888888888888', responseTime: 8.1, missedCalls: 18, followUpRate: 44, bookingConversionRate: 38, tasksCompleted: 18, tasksPending: 16, patientFeedbackScore: 3.6 },
  { email: 'chris.nwosu@carecommand.local', name: 'Chris Nwosu', roleTitle: 'Receptionist', branchId: '88888888-8888-4888-8888-888888888888', responseTime: 7.4, missedCalls: 12, followUpRate: 51, bookingConversionRate: 42, tasksCompleted: 22, tasksPending: 11, patientFeedbackScore: 3.8 },
  { email: 'karen.bloom@carecommand.local', name: 'Karen Bloom', roleTitle: 'Practice Manager', branchId, responseTime: 2.9, missedCalls: 1, followUpRate: 97, bookingConversionRate: 88, tasksCompleted: 64, tasksPending: 2, patientFeedbackScore: 4.9 },
] as const;

const staffUsers: Record<string, string> = {};
for (const staff of staffSeeds) {
  const user = await db.user.upsert({
    where: { tenantId_email: { tenantId, email: staff.email } },
    update: { displayName: staff.name, role: staff.roleTitle === 'Practice Manager' ? 'MANAGER' : 'FRONT_DESK', branchId: staff.branchId },
    create: {
      tenantId,
      branchId: staff.branchId,
      email: staff.email,
      displayName: staff.name,
      role: staff.roleTitle === 'Practice Manager' ? 'MANAGER' : 'FRONT_DESK',
    },
  });
  staffUsers[staff.email] = user.id;

  await ensureClinicAccess(user.id, staff.branchId, true);

  const existingProfile = await db.staffProfile.findFirst({ where: { tenantId, userId: user.id } });
  if (!existingProfile) {
    await db.staffProfile.create({
      data: {
        tenantId,
        branchId: staff.branchId,
        userId: user.id,
        roleTitle: staff.roleTitle,
        responseTime: staff.responseTime,
        missedCalls: staff.missedCalls,
        followUpRate: staff.followUpRate,
        bookingConversionRate: staff.bookingConversionRate,
        tasksCompleted: staff.tasksCompleted,
        tasksPending: staff.tasksPending,
        patientFeedbackScore: staff.patientFeedbackScore,
      },
    });
  }
}

await db.patient.upsert({
  where: { id: patientId },
  update: {},
  create: {
    id: patientId,
    tenantId,
    branchId,
    firstName: 'Charlotte',
    lastName: 'Whitmore',
    email: 'charlotte.whitmore@carecommand.local',
    phone: '+44 7700 900100',
    lifecycleStage: 'ACTIVE',
    churnRisk: 12,
    lifetimeValue: 4250,
    tags: ['vip', 'wellness'],
  },
});

for (const consent of [
  { purpose: 'EMAIL' as const, granted: true },
  { purpose: 'MARKETING' as const, granted: true },
]) {
  const existing = await db.consentEvent.findFirst({ where: { tenantId, patientId, purpose: consent.purpose } });
  if (!existing) await db.consentEvent.create({ data: { tenantId, patientId, source: 'seed', ...consent } });
}

const appointment = await db.appointment.findFirst({ where: { tenantId, patientId, service: 'Wellness Review' } });
if (!appointment) {
  await db.appointment.create({
    data: {
      tenantId, branchId, patientId, service: 'Wellness Review',
      startsAt: new Date('2026-06-03T09:00:00Z'), endsAt: new Date('2026-06-03T09:30:00Z'),
      channel: 'EMAIL', value: 180, noShowRisk: 12,
    },
  });
}

// Virtual visits (VIDEO channel) power the Telehealth module.
const virtualVisits = [
  { service: 'Virtual Dermatology Review', startsAt: '2026-06-03T10:00:00Z', endsAt: '2026-06-03T10:30:00Z', status: 'CONFIRMED' as const, value: 220, noShowRisk: 6, providerRef: 'Dr. Priya Sharma' },
  { service: 'Telehealth Nutrition Follow-up', startsAt: '2026-06-03T13:00:00Z', endsAt: '2026-06-03T13:30:00Z', status: 'WAITLIST' as const, value: 180, noShowRisk: 38, providerRef: 'Dr. Lisa Wong' },
];
for (const visit of virtualVisits) {
  const existing = await db.appointment.findFirst({ where: { tenantId, patientId, service: visit.service } });
  if (!existing) {
    await db.appointment.create({
      data: {
        tenantId, branchId, patientId, service: visit.service,
        startsAt: new Date(visit.startsAt), endsAt: new Date(visit.endsAt),
        status: visit.status, channel: 'VIDEO', value: visit.value, noShowRisk: visit.noShowRisk, providerRef: visit.providerRef,
      },
    });
  }
}

await db.integration.upsert({
  where: { tenantId_key: { tenantId, key: 'whatsapp-business' } },
  update: {},
  create: {
    tenantId, key: 'whatsapp-business', name: 'WhatsApp Business', category: 'Messaging', status: 'CONNECTED',
    config: { icon: 'MessagesSquare', description: 'Live two-way messaging and consent-aware appointment follow-up.' },
    lastSyncAt: new Date(),
  },
});

const review = await db.review.findFirst({ where: { tenantId, patientId, text: 'Smooth booking and genuinely thoughtful follow-up throughout.' } });
if (!review) await db.review.create({ data: { tenantId, branchId, patientId, rating: 5, text: 'Smooth booking and genuinely thoughtful follow-up throughout.', platform: 'google', sentiment: 'positive' } });

const report = await db.partnerReport.findFirst({ where: { tenantId, patientId, reportType: 'Partner wellness report' } });
if (!report) await db.partnerReport.create({ data: { tenantId, branchId, patientId, reportType: 'Partner wellness report', partner: 'TDL London', urgency: 'routine', status: 'result-received', summary: 'Wellness panel results ready for provider review.', reviewedAt: new Date('2026-06-02T10:20:00Z'), reviewedByUserId: userId } });

const task = await db.staffTask.findFirst({ where: { tenantId, title: 'Confirm wellness follow-up with Charlotte Whitmore' } });
if (!task) await db.staffTask.create({ data: { tenantId, branchId, assignedToId: userId, title: 'Confirm wellness follow-up with Charlotte Whitmore', priority: 'medium', dueAt: new Date('2026-06-01T12:00:00Z') } });

for (const seededTask of [
  { title: 'Follow up: Marcus Thompson (missed call)', branchId, priority: 'high', dueAt: new Date('2026-06-02T10:00:00Z'), assignedToEmail: 'aaron.mensah@carecommand.local', status: 'OPEN' },
  { title: 'Send reactivation message to Yuki Tanaka', branchId: '66666666-6666-4666-8666-666666666666', priority: 'high', dueAt: new Date('2026-06-02T15:00:00Z'), assignedToEmail: 'sara.haddad@carecommand.local', status: 'OPEN' },
  { title: 'Confirm Botox reorder with Allergan UK', branchId, priority: 'medium', dueAt: new Date('2026-06-02T17:00:00Z'), assignedToEmail: 'karen.bloom@carecommand.local', status: 'IN_PROGRESS' },
  { title: 'Review Dr. Mitchell appointment schedule gaps', branchId, priority: 'medium', dueAt: new Date('2026-06-03T10:00:00Z'), assignedToEmail: 'tanya.obi@carecommand.local', status: 'OPEN' },
  { title: 'Send post-visit review request to Sophie Laurent', branchId: '77777777-7777-4777-8777-777777777777', priority: 'low', dueAt: new Date('2026-06-03T11:00:00Z'), assignedToEmail: 'mia.larsson@carecommand.local', status: 'COMPLETED' },
  { title: 'Assign 14 follow-up customers to coordinators', branchId, priority: 'high', dueAt: new Date('2026-06-02T08:00:00Z'), assignedToEmail: 'blessing.eze@carecommand.local', status: 'OPEN' },
]) {
  const existingTask = await db.staffTask.findFirst({ where: { tenantId, title: seededTask.title } });
  if (!existingTask) {
    await db.staffTask.create({
      data: {
        tenantId,
        branchId: seededTask.branchId,
        assignedToId: staffUsers[seededTask.assignedToEmail] ?? userId,
        title: seededTask.title,
        priority: seededTask.priority,
        dueAt: seededTask.dueAt,
        status: seededTask.status as 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED',
      },
    });
  }
}

const snapshot = await db.revenueSnapshot.findFirst({ where: { tenantId, branchId: null, period: new Date('2026-06-01T00:00:00Z') } });
if (!snapshot) await db.revenueSnapshot.create({ data: { tenantId, period: new Date('2026-06-01T00:00:00Z'), revenue: 332000, recovered: 28600, lost: 24100, campaigns: 18200 } });

const conversation = await db.conversation.findFirst({ where: { tenantId, patientId, latestMessage: 'Hi, can I book a wellness review this week?' } });
if (!conversation) await db.conversation.create({
  data: {
    tenantId,
    branchId,
    patientId,
    channel: 'WHATSAPP',
    status: 'unread',
    intent: 'Booking inquiry',
    latestMessage: 'Hi, can I book a wellness review this week?',
    lastAgentMessage: 'Absolutely — we have openings on Thursday and Friday this week.',
    lastAgentMessageAt: new Date('2026-06-02T09:40:00Z'),
    estimatedValue: 180,
    aiHandled: true,
  },
});

for (const seededConversation of [
  {
    branchId,
    patientId,
    channel: 'CALL',
    status: 'ai-recovered',
    intent: 'Missed call recovery',
    latestMessage: 'Missed call from front desk at 08:42 — follow-up sent by AI.',
    lastAgentMessage: 'Sorry we missed you. Reply with a good time and we will reserve a slot.',
    lastAgentMessageAt: new Date('2026-06-02T08:50:00Z'),
    estimatedValue: 420,
    aiHandled: true,
  },
  {
    branchId,
    patientId,
    channel: 'SMS',
    status: 'replied',
    intent: 'Reschedule request',
    latestMessage: 'Can I move my treatment to later this week?',
    lastAgentMessage: 'Of course — I can move it to Friday at 11:00 if that works for you.',
    lastAgentMessageAt: new Date('2026-06-02T11:12:00Z'),
    estimatedValue: 260,
    aiHandled: true,
  },
  {
    branchId,
    patientId,
    channel: 'EMAIL',
    status: 'escalated',
    intent: 'Pricing escalation',
    latestMessage: 'I need a manager to review my package pricing.',
    lastAgentMessage: 'I have escalated this to the practice manager for a same-day review.',
    lastAgentMessageAt: new Date('2026-06-02T12:25:00Z'),
    estimatedValue: 580,
    aiHandled: false,
  },
]) {
  const existingConversation = await db.conversation.findFirst({
    where: {
      tenantId,
      channel: seededConversation.channel as 'CALL' | 'SMS' | 'EMAIL',
      intent: seededConversation.intent,
      latestMessage: seededConversation.latestMessage,
    },
  });
  if (!existingConversation) {
    await db.conversation.create({
      data: {
        tenantId,
        branchId: seededConversation.branchId,
        patientId: seededConversation.patientId,
        channel: seededConversation.channel as 'CALL' | 'SMS' | 'EMAIL',
        status: seededConversation.status,
        intent: seededConversation.intent,
        latestMessage: seededConversation.latestMessage,
        lastAgentMessage: seededConversation.lastAgentMessage,
        lastAgentMessageAt: seededConversation.lastAgentMessageAt,
        estimatedValue: seededConversation.estimatedValue,
        aiHandled: seededConversation.aiHandled,
      },
    });
  }
}

for (const competitor of [
  {
    name: 'Apex MediSuite Dental',
    distanceKm: 1.4,
    googleRating: 4.6,
    reviewVolume: 286,
    complaintThemes: ['long waits', 'hard upsell', 'weak follow-up'],
    activeOffers: ['Free consultation', '0% finance'],
    localRankTrend: 'down',
    weaknessSummary: 'Lower review velocity and inconsistent post-visit follow-up.',
    opportunityAlert: 'Rating gap opened up after recent complaint spikes.',
    marketOpeningRecommendation: 'Run a fast-response reputation and reactivation campaign.',
  },
  {
    name: 'Northgate Wellness Studio',
    distanceKm: 2.8,
    googleRating: 4.2,
    reviewVolume: 92,
    complaintThemes: ['pricing', 'availability'],
    activeOffers: ['Weekend bundle'],
    localRankTrend: 'flat',
    weaknessSummary: 'Weak local visibility and limited review momentum.',
    opportunityAlert: 'Their bundled offer is attracting price-sensitive leads.',
    marketOpeningRecommendation: 'Target value-led campaigns with clear booking urgency.',
  },
  {
    name: 'PrimeCare Clinic Group',
    distanceKm: 3.1,
    googleRating: 4.8,
    reviewVolume: 514,
    complaintThemes: ['wait times', 'phone delays'],
    activeOffers: ['Same-day booking'],
    localRankTrend: 'up',
    weaknessSummary: 'Strong reputation but slow call handling creates openings.',
    opportunityAlert: 'Phone delays are the most exploitable gap in the market.',
    marketOpeningRecommendation: 'Compete on response speed and missed-call recovery.',
  },
]) {
  const existingCompetitor = await db.competitor.findFirst({ where: { tenantId, name: competitor.name } });
  const competitorRow = existingCompetitor ?? await db.competitor.create({
    data: { tenantId, branchId, ...competitor },
  });
  const insightThemes = [
    { theme: 'waiting time', complaintCount: 14, summary: 'Patients often mention slow handoff from reception to consult.' },
    { theme: 'price transparency', complaintCount: 9, summary: 'Prospects are comparing pricing before booking.' },
  ];
  for (const insight of insightThemes) {
    const existingInsight = await db.competitorReviewInsight.findFirst({ where: { tenantId, competitorId: competitorRow.id, theme: insight.theme } });
    if (!existingInsight) {
      await db.competitorReviewInsight.create({ data: { tenantId, competitorId: competitorRow.id, ...insight } });
    }
  }
}

for (const reputationCase of [
  {
    complaintCategory: 'waiting-times',
    unresolvedComplaint: 'Patient experienced a 35-minute delay after a 5pm booking.',
    workflowStatus: 'needs-message',
    recoveryWorkflow: 'Send apology, explain cause, and offer priority rebooking.',
    suggestedReply: 'We are sorry for the delay. We value your time and would like to make this right.',
    badReviewRisk: 82,
    npsScore: 38,
    publicTrend: 'down',
    staffComplaintDetected: true,
  },
  {
    complaintCategory: 'communication-gap',
    unresolvedComplaint: 'Follow-up instructions were not received after the visit.',
    workflowStatus: 'in-review',
    recoveryWorkflow: 'Escalate to coordinator and resend instructions with follow-up task.',
    suggestedReply: 'Thank you for raising this. We are reviewing the follow-up process immediately.',
    badReviewRisk: 71,
    npsScore: 46,
    publicTrend: 'flat',
    staffComplaintDetected: false,
  },
  {
    complaintCategory: 'billing',
    unresolvedComplaint: 'Invoice clarification requested after the automated payment reminder.',
    workflowStatus: 'resolved',
    recoveryWorkflow: 'Confirm outstanding balance and close loop with a direct call.',
    suggestedReply: 'Thanks for flagging this. We have clarified the invoice and updated the account.',
    badReviewRisk: 54,
    npsScore: 58,
    publicTrend: 'up',
    staffComplaintDetected: false,
  },
]) {
  const existingCase = await db.reputationCase.findFirst({ where: { tenantId, complaintCategory: reputationCase.complaintCategory, unresolvedComplaint: reputationCase.unresolvedComplaint } });
  if (!existingCase) {
    await db.reputationCase.create({
      data: {
        tenantId,
        branchId,
        patientId: reputationCase.complaintCategory === 'waiting-times' ? patientId : undefined,
        ...reputationCase,
      },
    });
  }
}

for (const request of [
  {
    channel: 'WHATSAPP' as const,
    requestType: 'post-visit review request',
    status: 'SENT',
    message: 'Thanks for visiting. Would you leave a quick Google review about your experience?',
    sentAt: new Date('2026-06-01T15:00:00Z'),
    ratingReceived: 5,
  },
  {
    channel: 'SMS' as const,
    requestType: 'recovery-message',
    status: 'DELIVERED',
    message: 'We noticed a delay in your visit and wanted to follow up personally.',
    sentAt: new Date('2026-06-01T13:45:00Z'),
  },
  {
    channel: 'EMAIL' as const,
    requestType: 'family referral review',
    status: 'OPENED',
    message: 'Share your feedback and help your family know what to expect.',
    sentAt: new Date('2026-05-31T10:15:00Z'),
  },
]) {
  const existingRequest = await db.reviewRequest.findFirst({ where: { tenantId, requestType: request.requestType, message: request.message } });
  if (!existingRequest) {
    await db.reviewRequest.create({
      data: {
        tenantId,
        branchId,
        patientId,
        ...request,
      },
    });
  }
}

const ownerLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Missed call queue', evidence: '23 inbound calls missed before follow-up' } });
if (!ownerLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      patientId,
      ownerUserId: userId,
      category: 'missed-calls',
      source: 'Missed call queue',
      evidence: '23 inbound calls missed before follow-up',
      estimatedValue: 3450,
      confidence: 91,
      status: 'open',
      workflowStatus: 'needs-action',
      suggestedAction: 'Launch a 5-minute callback playbook and assign a recovery task to the front desk.',
    },
  });
}

const slotLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Open slot analysis', evidence: '31 empty slots detected on the Westside schedule' } });
if (!slotLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      category: 'unfilled-slots',
      source: 'Open slot analysis',
      evidence: '31 empty slots detected on the Westside schedule',
      estimatedValue: 6200,
      confidence: 87,
      status: 'open',
      workflowStatus: 'queued',
      suggestedAction: 'Run a weekday fill campaign with a limited-time offer and SMS follow-up.',
    },
  });
}

const inactiveLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Reactivation gap', evidence: '187 inactive patients have not been contacted in 90 days' } });
if (!inactiveLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      category: 'inactive-patients',
      source: 'Reactivation gap',
      evidence: '187 inactive patients have not been contacted in 90 days',
      estimatedValue: 18700,
      confidence: 83,
      status: 'open',
      workflowStatus: 'reviewed',
      suggestedAction: 'Trigger a winback sequence for high-value inactive patients with approval guardrails.',
    },
  });
}

for (const opportunity of [
  {
    title: 'Win back inactive patients',
    source: 'Customer reactivation model',
    category: 'reactivation',
    trigger: '90-day inactivity cohort',
    expectedRevenue: 18700,
    actualRevenue: 0,
    roi: 8.4,
    confidence: 86,
    effortLevel: 'medium',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Approve the inactive-patient campaign and dispatch SMS + email recovery.',
  },
  {
    title: 'Fill weekday gaps',
    source: 'Schedule capacity analysis',
    category: 'slot-fill',
    trigger: '31 open slots on Westside',
    expectedRevenue: 6200,
    actualRevenue: 0,
    roi: 5.7,
    confidence: 89,
    effortLevel: 'low',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Launch a short-notice promotion and offer online booking incentives.',
  },
  {
    title: 'Recover missed-call inquiries',
    source: 'Front desk call log',
    category: 'front-desk',
    trigger: 'Missed-call queue above threshold',
    expectedRevenue: 3450,
    actualRevenue: 780,
    roi: 6.2,
    confidence: 92,
    effortLevel: 'low',
    urgency: 'medium',
    status: 'running',
    ownerApprovalRequired: false,
    recommendedAction: 'Keep the callback workflow active and escalate unbooked callers after 10 minutes.',
  },
]) {
  const existingOpportunity = await db.opportunity.findFirst({ where: { tenantId, title: opportunity.title } });
  if (!existingOpportunity) {
    await db.opportunity.create({
      data: {
        tenantId,
        branchId,
        ownerUserId: userId,
        patientId: opportunity.title.includes('inactive') ? patientId : undefined,
        automationSteps: {
          trigger: opportunity.trigger,
          steps: ['detect', 'verify consent', 'queue action', 'measure outcome'],
        },
        ...opportunity,
      },
    });
  }
}

// Autopilot playbooks carry their operating metrics in `config` so the
// Autopilot page renders real DB-backed cards + derives KPIs (no hardcoded
// dashboard numbers). status: LIVE | DRAFT.
for (const playbook of [
  { key: 'empty-slot-rescue', name: 'Empty Slot Rescue', description: 'Match released capacity with consent-safe customer outreach.', status: 'LIVE' as const,
    config: { autonomyLevel: 2, icon: 'clock', trigger: 'Cancellation or under-utilised diary', action: 'Match waitlist, score fit, send consent-safe offer', runs: 34, successRate: 76, outcomeValue: 8420, monthlyHoursSaved: 14, guardrailBlocks: 6 } },
  { key: 'missed-call-recovery', name: 'Missed Call Recovery', description: 'Recover missed inquiries with channel-aware follow-up.', status: 'LIVE' as const,
    config: { autonomyLevel: 2, icon: 'activity', trigger: 'Call unanswered for 90 seconds', action: 'Identify intent, send WhatsApp/SMS, offer booking', runs: 51, successRate: 63, outcomeValue: 5880, monthlyHoursSaved: 12, guardrailBlocks: 4 } },
  { key: 'customer-winback', name: 'Customer Winback', description: 'Escalate or automate reactivation based on customer value.', status: 'LIVE' as const,
    config: { autonomyLevel: 2, icon: 'users', trigger: 'High-value customer inactive for 90 days', action: 'Build personal outreach journey with branch offer', runs: 187, successRate: 18, outcomeValue: 12900, monthlyHoursSaved: 11, guardrailBlocks: 5 } },
  { key: 'reputation-flywheel', name: 'Reputation Flywheel', description: 'Request reviews and route detractors to private recovery.', status: 'DRAFT' as const,
    config: { autonomyLevel: 1, icon: 'wand', trigger: 'Positive post-visit signal detected', action: 'Request review, route detractors to private recovery', runs: 96, successRate: 44, outcomeValue: 0, outcomeLabel: '42 reviews', monthlyHoursSaved: 5, guardrailBlocks: 2 } },
]) {
  await db.autopilotPlaybook.upsert({
    where: { tenantId_key: { tenantId, key: playbook.key } },
    update: { name: playbook.name, description: playbook.description, status: playbook.status, config: playbook.config },
    create: { tenantId, ...playbook },
  });
}

const playbookByKey: Record<string, string> = {};
for (const key of ['empty-slot-rescue', 'missed-call-recovery', 'customer-winback', 'reputation-flywheel']) {
  const pb = await db.autopilotPlaybook.findUnique({ where: { tenantId_key: { tenantId, key } } });
  if (pb) playbookByKey[key] = pb.id;
}

// Pending approvals (Approval Inbox — human-in-the-loop, real).
for (const ap of [
  { key: 'empty-slot-rescue', title: 'Activate Westside weekday slot-fill offer', reason: '31 empty slots detected · estimated £6,200 at risk', payload: { scope: 'Send to 84 matched customers', value: '£6,200' }, confidence: 91 },
  { key: 'customer-winback', title: 'Escalate 14 customers for personal follow-up', reason: 'High-LTV customers need a human touch after two automated attempts', payload: { scope: 'Create tasks for branch coordinators', value: '£4,800' }, confidence: 86 },
]) {
  const exists = await db.autopilotApproval.findFirst({ where: { tenantId, title: ap.title, status: 'PENDING' } });
  if (!exists) await db.autopilotApproval.create({ data: { tenantId, playbookId: playbookByKey[ap.key], title: ap.title, reason: ap.reason, payload: ap.payload, confidence: ap.confidence } });
}

// Executed/approved actions power the Live Audit Trail (real, explainable rows).
for (const ev of [
  { key: 'empty-slot-rescue', title: 'Booked a released Downtown slot from the waitlist', payload: { value: '+£320', kind: 'success' }, status: 'EXECUTED' as const, hoursAgo: 1.5, confidence: 88 },
  { key: 'empty-slot-rescue', title: 'Suppressed outreach: marketing consent not present', payload: { value: 'Blocked', kind: 'guardrail' }, status: 'EXECUTED' as const, hoursAgo: 1.7, confidence: 99 },
  { key: 'missed-call-recovery', title: 'Recovered a missed call with a WhatsApp booking link', payload: { value: '+£180', kind: 'success' }, status: 'EXECUTED' as const, hoursAgo: 2.4, confidence: 81 },
  { key: 'customer-winback', title: 'Created a personal follow-up task for a branch coordinator', payload: { value: 'Human step', kind: 'human' }, status: 'APPROVED' as const, hoursAgo: 3.1, confidence: 86 },
  { key: 'empty-slot-rescue', title: 'Filled a cancellation from a priority waitlist match', payload: { value: '+£480', kind: 'success' }, status: 'EXECUTED' as const, hoursAgo: 4.0, confidence: 84 },
]) {
  const exists = await db.autopilotApproval.findFirst({ where: { tenantId, title: ev.title } });
  if (!exists) await db.autopilotApproval.create({ data: { tenantId, playbookId: playbookByKey[ev.key], title: ev.title, reason: ev.title, payload: ev.payload, confidence: ev.confidence, status: ev.status, reviewedById: userId, reviewedAt: new Date(Date.now() - ev.hoursAgo * 3_600_000) } });
}

// ---- Demo population: customers, schedule, pipeline, stock, revenue ---------
const DAY = 86_400_000;
const NOW = Date.now();
const BR = {
  downtown: branchId,
  northgate: '66666666-6666-4666-8666-666666666666',
  southbank: '77777777-7777-4777-8777-777777777777',
  westside: '88888888-8888-4888-8888-888888888888',
};

const extraPatients = [
  { ref: 'p-amelia', firstName: 'Amelia', lastName: 'Hughes', branchId: BR.downtown, lifecycleStage: 'ACTIVE', churnRisk: 14, lifetimeValue: 5200, outstandingBalance: 0, tags: ['vip', 'skincare'], last: -9, next: 6, consents: ['WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-daniel', firstName: 'Daniel', lastName: 'Okoro', branchId: BR.downtown, lifecycleStage: 'AT_RISK', churnRisk: 67, lifetimeValue: 2840, outstandingBalance: 120, tags: ['follow-up'], last: -58, next: null, consents: ['SMS', 'EMAIL'] },
  { ref: 'p-sofia', firstName: 'Sofia', lastName: 'Marchetti', branchId: BR.northgate, lifecycleStage: 'NEW', churnRisk: 8, lifetimeValue: 320, outstandingBalance: 0, tags: ['new-lead'], last: -2, next: 11, consents: ['WHATSAPP'] },
  { ref: 'p-james', firstName: 'James', lastName: 'Whitfield', branchId: BR.southbank, lifecycleStage: 'ACTIVE', churnRisk: 22, lifetimeValue: 7650, outstandingBalance: 0, tags: ['dental', 'vip'], last: -16, next: 3, consents: ['SMS', 'WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-yuki', firstName: 'Yuki', lastName: 'Tanaka', branchId: BR.northgate, lifecycleStage: 'INACTIVE', churnRisk: 81, lifetimeValue: 1980, outstandingBalance: 0, tags: ['winback'], last: -124, next: null, consents: ['EMAIL'] },
  { ref: 'p-grace', firstName: 'Grace', lastName: 'Adeyemi', branchId: BR.downtown, lifecycleStage: 'RETAINED', churnRisk: 11, lifetimeValue: 9320, outstandingBalance: 0, tags: ['vip', 'referrer'], last: -5, next: 19, consents: ['WHATSAPP', 'SMS', 'EMAIL', 'MARKETING'] },
  { ref: 'p-tom', firstName: 'Tom', lastName: 'Nakamura', branchId: BR.westside, lifecycleStage: 'LOST', churnRisk: 94, lifetimeValue: 640, outstandingBalance: 0, tags: ['opted-out'], last: -210, next: null, consents: [] },
  { ref: 'p-sophie', firstName: 'Sophie', lastName: 'Laurent', branchId: BR.southbank, lifecycleStage: 'ACTIVE', churnRisk: 19, lifetimeValue: 4410, outstandingBalance: 260, tags: ['dental'], last: -7, next: 9, consents: ['WHATSAPP', 'EMAIL'] },
  { ref: 'p-marcus', firstName: 'Marcus', lastName: 'Thompson', branchId: BR.downtown, lifecycleStage: 'AT_RISK', churnRisk: 58, lifetimeValue: 3120, outstandingBalance: 0, tags: ['missed-call'], last: -41, next: null, consents: ['SMS'] },
  { ref: 'p-elena', firstName: 'Elena', lastName: 'Petrova', branchId: BR.northgate, lifecycleStage: 'ACTIVE', churnRisk: 27, lifetimeValue: 5870, outstandingBalance: 0, tags: ['nutrition'], last: -11, next: 14, consents: ['WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-omar', firstName: 'Omar', lastName: 'Farouk', branchId: BR.westside, lifecycleStage: 'NEW', churnRisk: 6, lifetimeValue: 180, outstandingBalance: 0, tags: ['new-lead'], last: -1, next: 5, consents: ['SMS', 'WHATSAPP'] },
] as const;

const patientPool: { id: string; branchId: string; name: string }[] = [
  { id: patientId, branchId, name: 'Charlotte Whitmore' },
];
for (const p of extraPatients) {
  const row = await db.patient.upsert({
    where: { tenantId_externalRef: { tenantId, externalRef: p.ref } },
    update: {},
    create: {
      tenantId, branchId: p.branchId, externalRef: p.ref,
      firstName: p.firstName, lastName: p.lastName,
      email: `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase()}@example.com`,
      phone: `+44 7700 9${String(Math.abs(p.churnRisk * 137) % 100000).padStart(5, '0')}`,
      lifecycleStage: p.lifecycleStage, churnRisk: p.churnRisk, lifetimeValue: p.lifetimeValue,
      outstandingBalance: p.outstandingBalance, tags: [...p.tags],
      lastVisitAt: p.last != null ? new Date(NOW + p.last * DAY) : null,
      nextVisitAt: p.next != null ? new Date(NOW + p.next * DAY) : null,
    },
  });
  patientPool.push({ id: row.id, branchId: p.branchId, name: `${p.firstName} ${p.lastName}` });
  for (const purpose of p.consents) {
    const existing = await db.consentEvent.findFirst({ where: { tenantId, patientId: row.id, purpose } });
    if (!existing) await db.consentEvent.create({ data: { tenantId, patientId: row.id, purpose, granted: true, source: 'seed' } });
  }
}

if (await db.appointment.count({ where: { tenantId } }) < 6) {
  const services = ['Botox Consultation', 'Dermatology Review', 'Dental Hygiene', 'Wellness Check', 'Physio Session', 'Nutrition Follow-up', 'Skin Treatment', 'Annual Health MOT'];
  const apptStatuses = ['CONFIRMED', 'CONFIRMED', 'COMPLETED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'WAITLIST'] as const;
  const apptChannels = ['WHATSAPP', 'SMS', 'EMAIL', 'CALL'] as const;
  for (let i = 0; i < 16; i++) {
    const patient = patientPool[i % patientPool.length];
    const offsetDays = (i % 6) - 2; // -2..3 days around today
    const start = new Date(NOW + offsetDays * DAY);
    start.setHours(9 + (i % 8), (i % 2) * 30, 0, 0);
    await db.appointment.create({
      data: {
        tenantId, branchId: patient.branchId, patientId: patient.id,
        providerRef: ['Dr. Sarah Mitchell', 'Dr. James Okafor', 'Dr. Priya Sharma', 'Dr. Marcus Bell'][i % 4],
        service: services[i % services.length],
        startsAt: start, endsAt: new Date(start.getTime() + 30 * 60000),
        status: apptStatuses[i % apptStatuses.length], channel: apptChannels[i % apptChannels.length],
        value: 120 + (i % 7) * 65, noShowRisk: (i * 13) % 90,
      },
    });
  }
}

if (await db.lead.count({ where: { tenantId } }) === 0) {
  // Stage vocabulary matches the CRM pipeline board.
  const leadStages = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'];
  const leadChannels = ['WHATSAPP', 'SMS', 'EMAIL', 'CALL', 'PUSH'] as const;
  const leadServices = ['Botox & Fillers', 'Dental Implants', 'Skin Resurfacing', 'Weight Management', 'Physiotherapy', 'General Consultation', 'Teeth Whitening', 'Nutrition Plan'];
  const leadSources = ['Google Ads', 'Instagram', 'Referral', 'Website widget', 'Walk-in', 'WhatsApp inbound'];
  const leadNames = ['Hannah Reed', 'Victor Almeida', 'Priya Nair', 'Leo Fischer', 'Maya Goldberg', 'Caleb Wright', 'Ines Costa', 'Dylan Murphy'];
  await db.lead.createMany({
    data: leadNames.map((name, i) => ({
      tenantId, name,
      phone: `+44 7911 ${String(100000 + i * 7777).slice(0, 6)}`,
      email: `${name.split(' ')[0].toLowerCase()}@example.com`,
      channel: leadChannels[i % leadChannels.length],
      service: leadServices[i % leadServices.length],
      stage: leadStages[i % leadStages.length],
      source: leadSources[i % leadSources.length],
      estimatedValue: 250 + (i % 6) * 480,
    })),
  });
}

if (await db.campaign.count({ where: { tenantId } }) === 0) {
  await db.campaign.createMany({
    data: [
      { tenantId, name: 'Spring Skin Refresh', goal: 'Promote seasonal skincare packages', status: 'ACTIVE', channels: ['WHATSAPP', 'EMAIL'], audienceSize: 640, sent: 640, opened: 410, responded: 96, booked: 38, revenue: 18240, aiGenerated: true, startsAt: new Date(NOW - 12 * DAY) },
      { tenantId, name: 'Lapsed Patient Winback', goal: 'Reactivate 90-day inactive customers', status: 'ACTIVE', channels: ['SMS', 'EMAIL'], audienceSize: 187, sent: 187, opened: 88, responded: 31, booked: 14, revenue: 9650, aiGenerated: true, startsAt: new Date(NOW - 6 * DAY) },
      { tenantId, name: 'Weekday Slot Fill', goal: 'Fill empty weekday appointment slots', status: 'SCHEDULED', channels: ['WHATSAPP'], audienceSize: 84, sent: 0, opened: 0, responded: 0, booked: 0, revenue: 0, aiGenerated: true, startsAt: new Date(NOW + 2 * DAY) },
      { tenantId, name: 'Dental Check-up Reminder', goal: '6-month recall for dental patients', status: 'COMPLETED', channels: ['SMS', 'EMAIL'], audienceSize: 312, sent: 312, opened: 240, responded: 71, booked: 52, revenue: 22100, aiGenerated: false, startsAt: new Date(NOW - 40 * DAY), endsAt: new Date(NOW - 10 * DAY) },
      { tenantId, name: 'Summer Wellness Bundle', goal: 'Cross-sell nutrition + physio package', status: 'DRAFT', channels: ['EMAIL', 'PUSH'], audienceSize: 0, sent: 0, opened: 0, responded: 0, booked: 0, revenue: 0, aiGenerated: true },
      { tenantId, name: 'Referral Reward Drive', goal: 'Encourage VIP patient referrals', status: 'PAUSED', channels: ['WHATSAPP', 'EMAIL'], audienceSize: 95, sent: 60, opened: 44, responded: 18, booked: 9, revenue: 6300, aiGenerated: false, startsAt: new Date(NOW - 20 * DAY) },
    ],
  });
}

// Reactivation engine campaigns (campaignType IS NOT NULL — surfaced by the
// /v1/crm reactivation engine, distinct from the legacy Campaigner rows above).
// Test data for formal testing: realistic states, rule-based drafts, consent-
// aware deliveries. No fake "sent" without a matching delivery record.
if (await db.campaign.count({ where: { tenantId, campaignType: { not: null } } }) === 0) {
  const reactivationCampaigns = [
    {
      name: '90-Day Inactive Win-Back', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
      campaignChannel: 'email', status: 'APPROVAL_REQUIRED' as const, requiresApproval: true, approved: false,
      messageSubject: 'We’d love to see you back, {{firstName}}',
      messageTemplate: 'Hi {{firstName}}, it’s been a while since your last visit to {{clinicName}}. Reply BOOK and we’ll find a time that works for you.',
      deliveries: [] as Array<{ idx: number; channel: string; status: string }>,
    },
    {
      name: 'No-Show Recovery — This Week', campaignType: 'no_show_recovery', audienceType: 'no_show_recovery',
      campaignChannel: 'sms', status: 'ACTIVE' as const, requiresApproval: true, approved: true,
      messageSubject: null, messageTemplate: 'Hi {{firstName}}, we missed you at your appointment. Reply RESCHEDULE to grab a new slot — no charge.',
      deliveries: [{ idx: 8, channel: 'sms', status: 'delivered' }, { idx: 1, channel: 'sms', status: 'sent' }, { idx: 4, channel: 'sms', status: 'failed' }],
    },
    {
      name: 'Post-Visit Review Requests', campaignType: 'review_request', audienceType: 'review_request',
      campaignChannel: 'email', status: 'COMPLETED' as const, requiresApproval: true, approved: true,
      messageSubject: 'How was your visit, {{firstName}}?',
      messageTemplate: 'Thanks for visiting {{clinicName}}, {{firstName}}. We’d be grateful for a quick review — it really helps our team.',
      deliveries: [{ idx: 5, channel: 'email', status: 'delivered' }, { idx: 3, channel: 'email', status: 'delivered' }, { idx: 9, channel: 'email', status: 'opened' }],
    },
    {
      name: 'Outstanding Deposit Follow-up', campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup',
      campaignChannel: 'whatsapp', status: 'DRAFT' as const, requiresApproval: true, approved: false,
      messageSubject: null, messageTemplate: 'Hi {{firstName}}, your booking is held pending a deposit. Tap the secure link to confirm your spot.',
      deliveries: [],
    },
    {
      name: 'Appointment Confirmations (48h)', campaignType: 'appointment_confirmation', audienceType: 'appointment_request_followup',
      campaignChannel: 'sms', status: 'SCHEDULED' as const, requiresApproval: true, approved: true,
      messageSubject: null, messageTemplate: 'Reminder: your appointment at {{clinicName}} is in 48 hours. Reply C to confirm or R to reschedule.',
      deliveries: [{ idx: 7, channel: 'sms', status: 'pending' }],
    },
  ];

  for (const c of reactivationCampaigns) {
    const campaign = await db.campaign.create({
      data: {
        tenantId, name: c.name, goal: c.campaignType, status: c.status, channels: [],
        campaignType: c.campaignType, audienceType: c.audienceType, campaignChannel: c.campaignChannel,
        messageSubject: c.messageSubject, messageTemplate: c.messageTemplate,
        draftSource: 'rule_based', requiresApproval: c.requiresApproval,
        ...(c.approved ? { approvedByUserId: userId, approvedAt: new Date(NOW - 2 * DAY) } : {}),
        ...(c.status === 'SCHEDULED' ? { scheduledAt: new Date(NOW + 2 * DAY) } : {}),
        createdByUserId: userId,
      },
    });
    for (const d of c.deliveries) {
      const p = patientPool[d.idx % patientPool.length];
      await db.campaignDelivery.create({
        data: {
          tenantId, campaignId: campaign.id, patientId: p.id, channel: d.channel,
          destinationMasked: d.channel === 'email' ? '•••@example.com' : '••• ••• ••12',
          status: d.status, provider: d.channel === 'email' ? 'http_email' : 'twilio',
          ...(d.status !== 'pending' && d.status !== 'failed' ? { sentAt: new Date(NOW - 1 * DAY) } : {}),
          ...(d.status === 'failed' ? { failureReason: 'carrier_rejected' } : {}),
        },
      });
    }
  }
}

if (await db.review.count({ where: { tenantId } }) < 4) {
  const reviewData = [
    { rating: 5, text: 'Dr. Mitchell was fantastic — quick, thorough and genuinely caring.', platform: 'google', sentiment: 'positive', responded: true, branchId: BR.downtown },
    { rating: 4, text: 'Good treatment but the wait was a little long at reception.', platform: 'google', sentiment: 'neutral', responded: false, aiDraftResponse: 'Thank you for your feedback — we are actively working to reduce reception wait times.', branchId: BR.downtown },
    { rating: 2, text: 'Felt rushed during my appointment and follow-up was slow.', platform: 'google', sentiment: 'negative', responded: false, aiDraftResponse: 'We are sorry to hear this. We would love to make it right — please reach out so we can follow up properly.', branchId: BR.westside },
    { rating: 5, text: 'Best dental experience I have had. Marcus and the team are brilliant.', platform: 'internal', sentiment: 'positive', responded: true, branchId: BR.southbank },
    { rating: 5, text: 'The nutrition programme changed my habits completely. Highly recommend.', platform: 'google', sentiment: 'positive', responded: false, aiDraftResponse: 'Thank you so much! We are thrilled the nutrition programme made such a difference.', branchId: BR.northgate },
    { rating: 3, text: 'Decent care but pricing felt unclear until the end.', platform: 'internal', sentiment: 'neutral', responded: false, aiDraftResponse: 'Thanks for flagging this — we are improving how we share pricing up front.', branchId: BR.northgate },
    { rating: 1, text: 'Booking system double-charged me and it took days to resolve.', platform: 'google', sentiment: 'negative', responded: false, aiDraftResponse: 'We sincerely apologise for the billing issue. Our manager will personally make this right.', branchId: BR.westside },
    { rating: 4, text: 'Lovely clinic, modern and clean. Physio really helped my back.', platform: 'google', sentiment: 'positive', responded: true, branchId: BR.northgate },
  ];
  for (let i = 0; i < reviewData.length; i++) {
    const r = reviewData[i];
    await db.review.create({
      data: {
        tenantId, branchId: r.branchId, patientId: patientPool[i % patientPool.length].id,
        rating: r.rating, text: r.text, platform: r.platform, sentiment: r.sentiment,
        responded: r.responded, aiDraftResponse: r.aiDraftResponse ?? null,
        createdAt: new Date(NOW - (i + 1) * 2 * DAY),
      },
    });
  }
}

if (await db.inventoryItem.count({ where: { tenantId } }) === 0) {
  const inventory = [
    { name: 'Botox 100u Vial', category: 'Injectables', currentStock: 4, unit: 'vial', reorderLevel: 6, expiry: 95, unitCost: 320, usagePerWeek: 3, supplier: 'Allergan UK' },
    { name: 'Dermal Filler 1ml', category: 'Injectables', currentStock: 12, unit: 'syringe', reorderLevel: 8, expiry: 160, unitCost: 145, usagePerWeek: 5, supplier: 'Juvederm' },
    { name: 'Nitrile Gloves (M)', category: 'Consumables', currentStock: 0, unit: 'box', reorderLevel: 10, expiry: null, unitCost: 6, usagePerWeek: 14, supplier: 'MediSupply' },
    { name: 'Composite Resin A2', category: 'Dental', currentStock: 9, unit: 'tube', reorderLevel: 5, expiry: 40, unitCost: 28, usagePerWeek: 4, supplier: '3M Dental' },
    { name: 'Local Anaesthetic 2%', category: 'Pharmacy', currentStock: 22, unit: 'cartridge', reorderLevel: 20, expiry: 220, unitCost: 2, usagePerWeek: 18, supplier: 'Septodont' },
    { name: 'Surgical Masks', category: 'Consumables', currentStock: 35, unit: 'box', reorderLevel: 15, expiry: null, unitCost: 8, usagePerWeek: 9, supplier: 'MediSupply' },
    { name: 'Vitamin B12 Injection', category: 'Pharmacy', currentStock: 3, unit: 'vial', reorderLevel: 5, expiry: 25, unitCost: 14, usagePerWeek: 2, supplier: 'Wellness Labs' },
    { name: 'Chemical Peel Solution', category: 'Skincare', currentStock: 7, unit: 'bottle', reorderLevel: 4, expiry: 75, unitCost: 62, usagePerWeek: 2, supplier: 'SkinCeuticals' },
    { name: 'Dental Implant Kit', category: 'Dental', currentStock: 5, unit: 'kit', reorderLevel: 3, expiry: null, unitCost: 410, usagePerWeek: 1, supplier: 'Straumann' },
    { name: 'Hyaluronic Serum', category: 'Skincare', currentStock: 18, unit: 'bottle', reorderLevel: 10, expiry: 130, unitCost: 38, usagePerWeek: 6, supplier: 'SkinCeuticals' },
    { name: 'Sterile Gauze Pads', category: 'Consumables', currentStock: 2, unit: 'pack', reorderLevel: 12, expiry: null, unitCost: 4, usagePerWeek: 11, supplier: 'MediSupply' },
    { name: 'Physio Resistance Bands', category: 'Equipment', currentStock: 14, unit: 'set', reorderLevel: 6, expiry: null, unitCost: 9, usagePerWeek: 1, supplier: 'TheraBand' },
  ];
  const invBranches = [BR.downtown, BR.southbank, BR.northgate, BR.westside];
  await db.inventoryItem.createMany({
    data: inventory.map((item, i) => ({
      tenantId, branchId: invBranches[i % invBranches.length],
      name: item.name, category: item.category, currentStock: item.currentStock, unit: item.unit,
      reorderLevel: item.reorderLevel, expiryDate: item.expiry != null ? new Date(NOW + item.expiry * DAY) : null,
      unitCost: item.unitCost, usagePerWeek: item.usagePerWeek, supplier: item.supplier,
    })),
  });
}

// 6 months of network revenue history for the Revenue chart.
const revenueHistory = [
  { monthsAgo: 5, revenue: 286000, recovered: 19400, lost: 31200, campaigns: 12800 },
  { monthsAgo: 4, revenue: 298500, recovered: 22100, lost: 28700, campaigns: 14200 },
  { monthsAgo: 3, revenue: 312800, recovered: 24800, lost: 26900, campaigns: 15600 },
  { monthsAgo: 2, revenue: 321400, recovered: 26300, lost: 25400, campaigns: 16900 },
  { monthsAgo: 1, revenue: 329900, recovered: 27800, lost: 24800, campaigns: 17600 },
];
for (const snap of revenueHistory) {
  const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - snap.monthsAgo, 1));
  const existing = await db.revenueSnapshot.findFirst({ where: { tenantId, branchId: null, period } });
  if (!existing) {
    await db.revenueSnapshot.create({
      data: { tenantId, period, revenue: snap.revenue, recovered: snap.recovered, lost: snap.lost, campaigns: snap.campaigns },
    });
  }
}

// ---- Revenue protection command center --------------------------------------
const payerSeeds = [
  { name: 'Stedi Test Payer', tradingPartnerServiceId: 'STEDI-TEST', sourceProvider: 'stedi', sortOrder: 0 },
  { name: 'Cigna', tradingPartnerServiceId: 'CIGNA', sourceProvider: 'stedi', sortOrder: 1 },
  { name: 'Aetna', tradingPartnerServiceId: 'AETNA', sourceProvider: 'stedi', sortOrder: 2 },
  { name: 'UnitedHealthcare', tradingPartnerServiceId: 'UHC', sourceProvider: 'stedi', sortOrder: 3 },
  { name: 'Blue Cross Blue Shield', tradingPartnerServiceId: 'BCBS', sourceProvider: 'stedi', sortOrder: 4 },
  { name: 'Humana', tradingPartnerServiceId: 'HUMANA', sourceProvider: 'stedi', sortOrder: 5 },
  { name: 'Kaiser Permanente', tradingPartnerServiceId: 'KAISER', sourceProvider: 'stedi', sortOrder: 6 },
];
for (const payer of payerSeeds) {
  const existing = await db.insurancePayer.findFirst({ where: { tenantId, name: payer.name } });
  if (!existing) {
    await db.insurancePayer.create({ data: { tenantId, ...payer, active: true } });
  }
}

const payerMap = new Map((await db.insurancePayer.findMany({ where: { tenantId, active: true } })).map(row => [row.name, row]));

const policyDefs = [
  { idx: 0, payerName: 'Cigna', planName: 'Cigna Choice Gold', memberId: 'CIG-428194', groupNumber: 'GRP-9012', verificationStatus: 'verified' },
  { idx: 1, payerName: 'Aetna', planName: 'Aetna Core Plus', memberId: 'AET-110293', groupNumber: 'GRP-2411', verificationStatus: 'verified' },
  { idx: 2, payerName: 'UnitedHealthcare', planName: 'UHC Balance Plan', memberId: 'UHC-551028', groupNumber: 'GRP-7740', verificationStatus: 'pending' },
  { idx: 3, payerName: 'Blue Cross Blue Shield', planName: 'BCBS PPO Silver', memberId: 'BCBS-773201', groupNumber: 'GRP-5521', verificationStatus: 'verified' },
  { idx: 4, payerName: 'Humana', planName: 'Humana Gold Plus HMO', memberId: 'HUM-660934', groupNumber: 'GRP-3088', verificationStatus: 'failed' },
  { idx: 5, payerName: 'Kaiser Permanente', planName: 'Kaiser Signature', memberId: 'KP-902187', groupNumber: 'GRP-1190', verificationStatus: 'verified' },
  { idx: 6, payerName: 'Cigna', planName: 'Cigna Open Access Plus', memberId: 'CIG-551240', groupNumber: 'GRP-8841', verificationStatus: 'verified' },
  { idx: 7, payerName: 'Aetna', planName: 'Aetna Select HMO', memberId: 'AET-330927', groupNumber: 'GRP-6610', verificationStatus: 'pending' },
  { idx: 8, payerName: 'UnitedHealthcare', planName: 'UHC Navigate Plus', memberId: 'UHC-884510', groupNumber: 'GRP-4402', verificationStatus: 'verified' },
];
const policySeeds = policyDefs
  .filter(d => patientPool[d.idx])
  .map(d => {
    const p = patientPool[d.idx];
    return { ...d, patientId: p.id, branchId: p.branchId, subscriberName: p.name };
  });
for (const policy of policySeeds) {
  const existing = await db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId: policy.patientId, active: true } });
  if (!existing) {
    await db.patientInsurancePolicy.create({
      data: {
        tenantId,
        branchId: policy.branchId,
        patientId: policy.patientId,
        payerId: payerMap.get(policy.payerName)?.id,
        planName: policy.planName,
        memberId: policy.memberId,
        groupNumber: policy.groupNumber,
        relationship: 'self',
        subscriberName: policy.subscriberName,
        payerReference: policy.memberId,
        verificationStatus: policy.verificationStatus,
        verifiedAt: policy.verificationStatus === 'verified' ? new Date() : null,
        active: true,
      },
    });
  } else if (existing.verificationStatus !== policy.verificationStatus) {
    // Refresh verification status on re-seed so the overview shows verified coverage.
    await db.patientInsurancePolicy.update({
      where: { id: existing.id },
      data: { verificationStatus: policy.verificationStatus, verifiedAt: policy.verificationStatus === 'verified' ? new Date() : null },
    });
  }
}

// ---- Device Integration Center (connected IoT / clinical devices) -----------
const deviceSeeds = [
  { name: 'Welch Allyn Connex Spot Monitor', deviceType: 'vitals_monitor', vendor: 'Hillrom', model: 'Connex 7100', serialNumber: 'WA-7100-0481', connectionType: 'network', status: 'online', location: 'Triage Room 1', firmwareVersion: '2.41.00' },
  { name: 'Abbott i-STAT Analyzer', deviceType: 'lab_analyzer', vendor: 'Abbott', model: 'i-STAT 1', serialNumber: 'IS1-22910', connectionType: 'cloud_api', status: 'online', location: 'Lab Bench A', firmwareVersion: 'JAMS-168' },
  { name: 'Front Desk Check-in Kiosk', deviceType: 'check_in_kiosk', vendor: 'CareCommand', model: 'CC-Kiosk Mini', serialNumber: 'KIOSK-014', connectionType: 'network', status: 'online', location: 'Reception', firmwareVersion: '1.8.2' },
  { name: 'Fujitsu fi-8170 Scanner', deviceType: 'document_scanner', vendor: 'Fujitsu', model: 'fi-8170', serialNumber: 'FJ-8170-3320', connectionType: 'usb', status: 'offline', location: 'Records Office', firmwareVersion: '0140' },
  { name: 'Mindray Resona Ultrasound', deviceType: 'imaging', vendor: 'Mindray', model: 'Resona I9', serialNumber: 'MR-I9-7741', connectionType: 'network', status: 'error', location: 'Imaging Suite', firmwareVersion: '3.02.10', notes: 'DICOM node unreachable — check network route' },
  { name: 'Withings Patient Gateway', deviceType: 'wearable_gateway', vendor: 'Withings', model: 'Hub Pro', serialNumber: 'WH-PRO-0099', connectionType: 'bluetooth', status: 'pending', location: 'Remote Monitoring', firmwareVersion: '4.1.0' },
];
for (const device of deviceSeeds) {
  let existing = await db.device.findFirst({ where: { tenantId, name: device.name } });
  if (!existing) {
    existing = await db.device.create({
      data: {
        tenantId,
        branchId,
        ...device,
        lastSeenAt: device.status === 'online' ? new Date() : device.status === 'error' ? new Date(Date.now() - 36e5) : null,
        lastTestStatus: device.status === 'online' ? 'passed' : null,
        lastTestedAt: device.status === 'online' ? new Date() : null,
        active: true,
      },
    });
  }
  // Backfill a starter timeline so the detail drawer isn't empty.
  const eventCount = await db.deviceEvent.count({ where: { tenantId, deviceId: existing.id } });
  if (eventCount === 0) {
    const base = Date.now() - 72e5; // ~2h ago
    await db.deviceEvent.create({ data: { tenantId, deviceId: existing.id, type: 'registered', toStatus: 'pending', message: `Registered via ${device.connectionType}`, createdAt: new Date(base) } });
    if (device.status === 'online') {
      await db.deviceEvent.create({ data: { tenantId, deviceId: existing.id, type: 'connection_test', fromStatus: 'pending', toStatus: 'online', message: 'Local readiness check passed', createdAt: new Date(base + 36e5) } });
    } else if (device.status === 'error') {
      await db.deviceEvent.create({ data: { tenantId, deviceId: existing.id, type: 'status_changed', fromStatus: 'pending', toStatus: 'error', message: device.notes ?? 'Connection error detected', createdAt: new Date(base + 36e5) } });
    } else if (device.status === 'offline') {
      await db.deviceEvent.create({ data: { tenantId, deviceId: existing.id, type: 'status_changed', fromStatus: 'online', toStatus: 'offline', message: 'Device went offline', createdAt: new Date(base + 36e5) } });
    }
  }
}

for (const rule of [
  { branchId: null, name: 'New patient deposit', ruleType: 'new-patient', description: 'Collect a deposit for new patients before arrival.', amountType: 'fixed', amountValue: 50, refundable: false, cancellationWindowHours: 24, appliesToNewPatients: true, appliesToHighNoShowRisk: false, appliesToPremiumServices: false, appliesToSameDayAppointments: false, appliesToExemptPatients: false, sortOrder: 0 },
  { branchId: null, name: 'High no-show hold', ruleType: 'risk-based', description: 'Apply a higher deposit for patients with elevated no-show risk.', amountType: 'percentage', amountValue: 25, refundable: true, cancellationWindowHours: 12, appliesToNewPatients: false, appliesToHighNoShowRisk: true, appliesToPremiumServices: false, appliesToSameDayAppointments: true, appliesToExemptPatients: false, sortOrder: 1 },
  { branchId: BR.westside, name: 'Premium service deposit', ruleType: 'premium-service', description: 'Collect an upfront deposit for higher value premium services.', amountType: 'fixed', amountValue: 120, refundable: false, cancellationWindowHours: 48, appliesToNewPatients: false, appliesToHighNoShowRisk: false, appliesToPremiumServices: true, appliesToSameDayAppointments: false, appliesToExemptPatients: false, sortOrder: 2 },
]) {
  const existing = await db.depositRule.findFirst({ where: { tenantId, name: rule.name } });
  if (!existing) {
    await db.depositRule.create({
      data: {
        tenantId,
        active: true,
        depositRequired: true,
        ...rule,
        branchId: rule.branchId ?? undefined,
      },
    });
  }
}

const [cignaPayer, aetnaPayer, uhcPayer] = ['Cigna', 'Aetna', 'UnitedHealthcare'].map(name => payerMap.get(name));
const policyRows = await db.patientInsurancePolicy.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } });
const cignaPolicy = policyRows[0];
const aetnaPolicy = policyRows[1];
const uhcPolicy = policyRows[2];
const seededAppointments = await db.appointment.findMany({ where: { tenantId }, orderBy: { startsAt: 'asc' }, take: 8 });

const eligibilitySeeds = [
  {
    patientId: cignaPolicy.patientId,
    appointmentId: seededAppointments[0]?.id ?? null,
    payerId: cignaPayer?.id ?? null,
    policyId: cignaPolicy.id,
    providerMode: 'sandbox',
    coverageStatus: 'active',
    planName: cignaPolicy.planName,
    payerName: 'Cigna',
    copay: 35,
    deductibleRemaining: 1350,
    coinsurance: 0.2,
    coverageActive: true,
    eligibilityMessage: 'Coverage active with a deductible balance. Collect a deposit before arrival.',
    payerReference: cignaPolicy.memberId,
  },
  {
    patientId: aetnaPolicy.patientId,
    appointmentId: seededAppointments[1]?.id ?? null,
    payerId: aetnaPayer?.id ?? null,
    policyId: aetnaPolicy.id,
    providerMode: 'sandbox',
    coverageStatus: 'uncertain',
    planName: aetnaPolicy.planName,
    payerName: 'Aetna',
    copay: 40,
    deductibleRemaining: 1850,
    coinsurance: 0.25,
    coverageActive: true,
    eligibilityMessage: 'Benefits are active but the payer response is uncertain. Review before treatment.',
    payerReference: aetnaPolicy.memberId,
  },
  {
    patientId: uhcPolicy.patientId,
    appointmentId: seededAppointments[2]?.id ?? null,
    payerId: uhcPayer?.id ?? null,
    policyId: uhcPolicy.id,
    providerMode: 'mock',
    coverageStatus: 'inactive',
    planName: uhcPolicy.planName,
    payerName: 'UnitedHealthcare',
    copay: 0,
    deductibleRemaining: 0,
    coinsurance: 0,
    coverageActive: false,
    eligibilityMessage: 'Coverage inactive; front desk should verify and route to follow-up.',
    payerReference: uhcPolicy.memberId,
  },
];
for (const seed of eligibilitySeeds) {
  const existing = await db.eligibilityVerification.findFirst({ where: { tenantId, patientId: seed.patientId, payerReference: seed.payerReference } });
  if (!existing) {
    const row = await db.eligibilityVerification.create({
      data: {
        tenantId,
        branchId: (await db.patient.findUnique({ where: { id: seed.patientId }, select: { branchId: true } }))?.branchId ?? branchId,
        patientId: seed.patientId,
        appointmentId: seed.appointmentId ?? undefined,
        payerId: seed.payerId ?? undefined,
        policyId: seed.policyId,
        providerMode: seed.providerMode,
        coverageStatus: seed.coverageStatus,
        planName: seed.planName,
        payerName: seed.payerName,
        copay: seed.copay,
        deductibleRemaining: seed.deductibleRemaining,
        coinsurance: seed.coinsurance,
        coverageActive: seed.coverageActive,
        eligibilityMessage: seed.eligibilityMessage,
        payerReference: seed.payerReference,
        normalizedResponse: {
          coverageStatus: seed.coverageStatus,
          planName: seed.planName,
          payerName: seed.payerName,
          copay: seed.copay,
          deductibleRemaining: seed.deductibleRemaining,
          coinsurance: seed.coinsurance,
          coverageActive: seed.coverageActive,
          eligibilityMessage: seed.eligibilityMessage,
          providerMode: seed.providerMode,
          providerName: seed.providerMode === 'sandbox' ? 'Stedi Eligibility' : 'Mock Eligibility',
        },
      },
    });
    await db.benefitSnapshot.create({
      data: {
        tenantId,
        branchId: (await db.patient.findUnique({ where: { id: seed.patientId }, select: { branchId: true } }))?.branchId ?? branchId,
        verificationId: row.id,
        summary: seed.eligibilityMessage,
        details: { seeded: true, payerName: seed.payerName, planName: seed.planName },
      },
    });
    await db.patientResponsibilityEstimate.create({
      data: {
        tenantId,
        branchId: (await db.patient.findUnique({ where: { id: seed.patientId }, select: { branchId: true } }))?.branchId ?? branchId,
        patientId: seed.patientId,
        appointmentId: seed.appointmentId ?? undefined,
        eligibilityVerificationId: row.id,
        estimatedInsurancePortion: 90,
        estimatedPatientResponsibility: 180,
        recommendedCollectAmount: 90,
        reason: seed.coverageActive ? 'Seeded estimate based on active coverage.' : 'Seeded estimate based on inactive coverage.',
      },
    });
  }
}

for (const auth of [
  { branchId: BR.downtown, patientId: cignaPolicy.patientId, payerId: cignaPayer?.id ?? null, serviceName: 'Botox consultation', authNumber: 'AUTH-34091', status: 'pending', dueAt: new Date(NOW + 5 * DAY), notes: 'High-value aesthetic service requires prior authorisation.', lastUpdatedAt: new Date(NOW - DAY) },
  { branchId: BR.northgate, patientId: aetnaPolicy.patientId, payerId: aetnaPayer?.id ?? null, serviceName: 'Dermatology procedure', authNumber: 'AUTH-88011', status: 'submitted', dueAt: new Date(NOW + 2 * DAY), notes: 'Submitted to payer; awaiting determination.', lastUpdatedAt: new Date(NOW - DAY) },
  { branchId: BR.southbank, patientId: uhcPolicy.patientId, payerId: uhcPayer?.id ?? null, serviceName: 'Dental implant review', authNumber: 'AUTH-55120', status: 'needs_action', dueAt: new Date(NOW + 1 * DAY), notes: 'Need chart note before approval can proceed.', lastUpdatedAt: new Date(NOW - DAY) },
]) {
  const existing = await db.priorAuthorization.findFirst({ where: { tenantId, authNumber: auth.authNumber } });
  if (!existing) {
    await db.priorAuthorization.create({ data: { tenantId, ...auth } });
  }
}

for (const request of [
  { branchId: BR.downtown, patientId: cignaPolicy.patientId, appointmentId: seededAppointments[0]?.id ?? null, amount: 90, status: 'link_sent', reason: 'Copay and deposit request', mode: 'sandbox', paymentUrl: 'https://example.com/pay/cigna', providerReference: 'plink_seed_1', dueAt: new Date(NOW + DAY), collectedAmount: 0, collected: false },
  { branchId: BR.northgate, patientId: aetnaPolicy.patientId, appointmentId: seededAppointments[1]?.id ?? null, amount: 130, status: 'pending', reason: 'High deductible deposit', mode: 'mock', paymentUrl: 'http://localhost:12000/revenue-protection?payment=seed_2', providerReference: 'mock_seed_2', dueAt: new Date(NOW + DAY), collectedAmount: 0, collected: false },
  { branchId: BR.southbank, patientId: uhcPolicy.patientId, appointmentId: seededAppointments[2]?.id ?? null, amount: 75, status: 'collected', reason: 'Follow-up payment', mode: 'sandbox', paymentUrl: 'https://example.com/pay/uhc', providerReference: 'cs_seed_3', dueAt: new Date(NOW - DAY), collectedAmount: 75, collected: true },
]) {
  const existing = await db.paymentRequest.findFirst({ where: { tenantId, providerReference: request.providerReference } });
  if (!existing) {
    const row = await db.paymentRequest.create({
      data: {
        tenantId,
        branchId: request.branchId,
        patientId: request.patientId,
        appointmentId: request.appointmentId ?? undefined,
        amount: request.amount,
        currency: 'USD',
        status: request.status,
        reason: request.reason,
        mode: request.mode,
        paymentUrl: request.paymentUrl,
        providerReference: request.providerReference,
        dueAt: request.dueAt,
      },
    });
    if (request.collected) {
      await db.paymentTransaction.create({
        data: {
          tenantId,
          branchId: request.branchId,
          patientId: request.patientId,
          appointmentId: request.appointmentId ?? undefined,
          paymentRequestId: row.id,
          amount: request.collectedAmount,
          currency: 'USD',
          status: 'succeeded',
          mode: request.mode,
          providerReference: request.providerReference,
          receivedAt: new Date(NOW - 4 * DAY),
          rawResponse: { source: 'seed', status: 'succeeded' },
        },
      });
    }
  }
}

for (const requirement of [
  { branchId: BR.downtown, patientId: cignaPolicy.patientId, appointmentId: seededAppointments[0]?.id ?? null, depositRuleId: null, status: 'requested', requiredAmount: 90, collectedAmount: 0, waiverReason: null, reason: 'New patient deposit', mode: 'sandbox', dueAt: new Date(NOW + DAY), collectedAt: null },
  { branchId: BR.northgate, patientId: aetnaPolicy.patientId, appointmentId: seededAppointments[1]?.id ?? null, depositRuleId: null, status: 'waived', requiredAmount: 130, collectedAmount: 0, waiverReason: 'Clinical manager approved a same-day waiver', reason: 'High no-show hold', mode: 'mock', dueAt: new Date(NOW + DAY), collectedAt: null },
  { branchId: BR.southbank, patientId: uhcPolicy.patientId, appointmentId: seededAppointments[2]?.id ?? null, depositRuleId: null, status: 'collected', requiredAmount: 75, collectedAmount: 75, waiverReason: null, reason: 'Premium service deposit', mode: 'sandbox', dueAt: new Date(NOW - DAY), collectedAt: new Date(NOW - DAY / 2) },
]) {
  const existing = await db.depositRequirement.findFirst({ where: { tenantId, branchId: requirement.branchId, reason: requirement.reason, patientId: requirement.patientId } });
  if (!existing) {
    await db.depositRequirement.create({ data: { tenantId, ...requirement } });
  }
}

for (const alert of [
  { branchId: BR.downtown, patientId: cignaPolicy.patientId, appointmentId: seededAppointments[0]?.id ?? null, sourceType: 'eligibility', severity: 'high', title: 'Coverage inactive risk', description: 'Coverage is active but a large deductible still needs collection.', evidence: { type: 'eligibility', gap: 1350 }, estimatedValue: 420, status: 'open', recommendedAction: 'Collect a deposit and keep the front desk in the loop.', actionLink: '/revenue-protection' },
  { branchId: BR.northgate, patientId: aetnaPolicy.patientId, appointmentId: seededAppointments[1]?.id ?? null, sourceType: 'payment', severity: 'medium', title: 'Payment link pending', description: 'A payment request is pending follow-up.', evidence: { type: 'payment', pending: true }, estimatedValue: 180, status: 'follow_up_required', recommendedAction: 'Send the payment link again and assign a callback task.', actionLink: '/revenue-protection' },
  { branchId: BR.westside, patientId: patientId, appointmentId: seededAppointments[3]?.id ?? null, sourceType: 'deposit', severity: 'medium', title: 'Deposit not collected', description: 'A high-value booking remains without a deposit.', evidence: { type: 'deposit', amount: 120 }, estimatedValue: 260, status: 'task_created', recommendedAction: 'Create a recovery task for the front desk.', actionLink: '/staff' },
]) {
  const existing = await db.revenueProtectionAlert.findFirst({ where: { tenantId, title: alert.title } });
  if (!existing) {
    await db.revenueProtectionAlert.create({ data: { tenantId, ...alert } });
  }
}

if (await db.paymentProviderConnection.count({ where: { tenantId } }) === 0) {
  await db.paymentProviderConnection.createMany({
    data: [
      { tenantId, providerKey: 'mock', displayName: 'Mock Payments', mode: 'mock', status: 'connected', baseUrl: null, connectedAt: new Date(NOW - DAY), lastSyncAt: new Date(NOW - DAY / 2), configuration: { description: 'Sandbox payment provider for evaluation environments.' } },
      { tenantId, providerKey: 'stripe', displayName: 'Stripe Test Mode', mode: 'sandbox', status: 'connected', baseUrl: 'https://api.stripe.com', connectedAt: new Date(NOW - 5 * DAY), lastSyncAt: new Date(NOW - DAY), configuration: { description: 'Sandbox-ready payment link and checkout session mode.' } },
    ],
  });
}

if (await db.integrationRunLog.count({ where: { tenantId } }) === 0) {
  await db.integrationRunLog.createMany({
    data: [
      { tenantId, branchId: BR.downtown, provider: 'stedi', providerMode: 'sandbox', operation: 'eligibility.check', status: 'success', requestSummary: { patientId: cignaPolicy.patientId }, responseSummary: { coverageStatus: 'active' }, createdAt: new Date(NOW - 3 * DAY) },
      { tenantId, branchId: BR.northgate, provider: 'stripe', providerMode: 'sandbox', operation: 'payment.link', status: 'success', requestSummary: { amount: 130 }, responseSummary: { status: 'pending' }, createdAt: new Date(NOW - 2 * DAY) },
    ],
  });
}

// ---- Configuration management defaults --------------------------------------
if (await db.notificationTemplate.count({ where: { tenantId } }) === 0) {
  await db.notificationTemplate.createMany({
    data: [
      { tenantId, name: 'Appointment reminder (24h)', channel: 'WhatsApp + SMS', status: 'ACTIVE' },
      { tenantId, name: 'Post-visit review request', channel: 'WhatsApp', status: 'ACTIVE' },
      { tenantId, name: 'Missed call follow-up', channel: 'SMS', status: 'ACTIVE' },
      { tenantId, name: 'Reactivation campaign (90d inactive)', channel: 'WhatsApp + Email', status: 'ACTIVE' },
      { tenantId, name: 'Winback offer (180d inactive)', channel: 'Email', status: 'PAUSED' },
    ],
  });
}

if (await db.aiGuardrail.count({ where: { tenantId } }) === 0) {
  await db.aiGuardrail.createMany({
    data: [
      { tenantId, rule: 'No clinical diagnosis or medical advice generated', sortOrder: 0 },
      { tenantId, rule: 'Clinical questions routed to provider, not answered automatically', sortOrder: 1 },
      { tenantId, rule: 'Marketing messages sent only to opted-in customers', sortOrder: 2 },
      { tenantId, rule: 'Role-based access: front desk cannot view financial records', sortOrder: 3 },
      { tenantId, rule: 'All AI-generated content reviewed before sending', sortOrder: 4 },
      { tenantId, rule: 'Data retained per GDPR 6-year retention policy', sortOrder: 5 },
    ],
  });
}

if (await db.customerPreference.count({ where: { tenantId } }) === 0) {
  await db.customerPreference.createMany({
    data: [
      { tenantId, label: 'Appointment reminders', description: 'Auto-sent via preferred channel', enabled: true, sortOrder: 0 },
      { tenantId, label: 'Promotional campaigns', description: 'Only for opted-in customers', enabled: true, sortOrder: 1 },
      { tenantId, label: 'Post-visit review requests', description: '24h after appointment', enabled: true, sortOrder: 2 },
      { tenantId, label: 'Winback & reactivation', description: 'Marketing consent required', enabled: true, sortOrder: 3 },
    ],
  });
}

for (const role of [
  { name: 'Owner', description: 'Full access to all modules, billing, and settings.', accent: 'violet', sortOrder: 0 },
  { name: 'Branch Manager', description: 'Access to branch-level data, staff, and inventory.', accent: 'blue', sortOrder: 1 },
  { name: 'Billing', description: 'Finance, payment, and reimbursement workflows.', accent: 'amber', sortOrder: 2 },
  { name: 'Provider', description: 'Own schedule, patient notes, and follow-up tools.', accent: 'emerald', sortOrder: 3 },
  { name: 'Front Desk', description: 'Scheduling, CRM, and inbound communication.', accent: 'blue', sortOrder: 4 },
  { name: 'Analyst', description: 'Read-only operational and financial reporting.', accent: 'violet', sortOrder: 5 },
]) {
  await db.roleDefinition.upsert({
    where: { tenantId_name: { tenantId, name: role.name } },
    update: { description: role.description, accent: role.accent, sortOrder: role.sortOrder },
    create: { tenantId, ...role },
  });
}

// ---- AI Receptionist Studio ------------------------------------------------
const receptionistClinicId = '55555555-5555-4555-8555-555555555555';
const receptionistLocationDowntownId = '55555555-5555-4555-8555-555555550001';
const receptionistLocationUptownId = '55555555-5555-4555-8555-555555550002';
const receptionistAgentId = '55555555-5555-4555-8555-555555550010';
const receptionistCampaignId = '55555555-5555-4555-8555-555555550020';

if (await db.receptionistClinic.count({ where: { id: receptionistClinicId } }) === 0) {
  await db.receptionistClinic.create({
    data: {
      id: receptionistClinicId,
      tenantId,
      name: 'Brightsmile Dental Group',
      phone: '+1 (415) 555-0142',
      website: 'https://brightsmile.example.com',
      addressLine: '500 Market Street, San Francisco, CA',
      timezone: 'America/Los_Angeles',
      defaultLanguage: 'en-US',
      complianceDisclosure: 'Hi, this is Riley, the AI assistant calling on behalf of Brightsmile Dental Group.',
      humanFallbackNumber: '+1 (415) 555-0100',
      doNotContactPolicy: 'If the caller asks not to be contacted again, confirm warmly, apologize for the interruption, and mark them do-not-contact across all channels.',
      workingHours: {
        monday: '08:00-17:00', tuesday: '08:00-17:00', wednesday: '08:00-17:00',
        thursday: '08:00-17:00', friday: '08:00-15:00', saturday: 'closed', sunday: 'closed',
      },
      active: true,
    },
  });

  await db.receptionistLocation.createMany({
    data: [
      { id: receptionistLocationDowntownId, tenantId, clinicId: receptionistClinicId, name: 'Downtown Office', address: '500 Market Street, San Francisco, CA', phone: '+1 (415) 555-0142', timezone: 'America/Los_Angeles' },
      { id: receptionistLocationUptownId, tenantId, clinicId: receptionistClinicId, name: 'Uptown Office', address: '2200 Fillmore Street, San Francisco, CA', phone: '+1 (415) 555-0188', timezone: 'America/Los_Angeles' },
    ],
  });

  await db.receptionistAgent.create({
    data: {
      id: receptionistAgentId,
      tenantId,
      clinicId: receptionistClinicId,
      name: 'Riley',
      voice: '11labs-Adrian',
      tone: 'Warm, upbeat, and concise',
      language: 'en-US',
      persona: 'You are friendly and efficient, you smile through the phone, and you never sound robotic or pushy.',
      greetingOverride: 'Hi, this is Riley, the AI assistant calling on behalf of Brightsmile Dental Group.',
      active: true,
    },
  });

  await db.receptionistCampaign.create({
    data: {
      id: receptionistCampaignId,
      tenantId,
      clinicId: receptionistClinicId,
      agentId: receptionistAgentId,
      name: 'Spring Cleaning Reactivation',
      campaignType: 'Reactivation',
      status: 'ACTIVE',
      offerTitle: 'Complimentary New-Patient Cleaning & Exam',
      offerDescription: 'A no-cost cleaning, exam, and digital X-rays for patients who have not visited in over 12 months.',
      offerScript: "We're reaching out because it's been a little while since your last visit, and we'd love to welcome you back with a complimentary cleaning, exam, and digital X-rays. It usually takes about 45 minutes. Would you like me to find a time that works for you?",
      appointmentType: 'New-patient cleaning & exam',
      bookingRules: {
        leadTimeHours: 24,
        slotDurationMinutes: 45,
        maxPerDay: 6,
        availableDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        hoursStart: '08:00',
        hoursEnd: '16:30',
        notes: 'Saturdays are reserved for emergencies only.',
      },
      eligibleLocationIds: [receptionistLocationDowntownId, receptionistLocationUptownId],
      smsConfirmation: true,
      emailConfirmation: true,
    },
  });

  await db.receptionistIntakeField.createMany({
    data: [
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'FIRST_NAME', label: 'First name', aiQuestion: 'Can I start with your first name?', required: true, confirmationRequired: false, sortOrder: 0, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'LAST_NAME', label: 'Last name', aiQuestion: 'And your last name?', required: true, confirmationRequired: false, sortOrder: 1, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'PHONE', label: 'Phone number', aiQuestion: 'What is the best phone number to reach you on?', validationRule: 'US phone number — read back to confirm', required: true, confirmationRequired: true, sortOrder: 2, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'EMAIL', label: 'Email', aiQuestion: 'What email should we send the confirmation to?', validationRule: 'email — read back to confirm', required: false, confirmationRequired: true, sortOrder: 3, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'PREFERRED_LOCATION', label: 'Preferred location', aiQuestion: 'Which office is more convenient — Downtown or Uptown?', required: true, confirmationRequired: false, sortOrder: 4, options: ['Downtown Office', 'Uptown Office'] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'PREFERRED_DATE', label: 'Preferred date', aiQuestion: 'What day works best for you this week or next?', required: true, confirmationRequired: false, sortOrder: 5, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'PREFERRED_TIME', label: 'Preferred time', aiQuestion: 'Do you prefer a morning or afternoon appointment?', required: true, confirmationRequired: false, sortOrder: 6, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'INSURANCE_PROVIDER', label: 'Insurance provider', aiQuestion: 'Do you have dental insurance, and if so, who is your provider?', validationRule: 'carrier name only — never policy numbers', required: false, confirmationRequired: false, sortOrder: 7, options: [] },
      { tenantId, campaignId: receptionistCampaignId, fieldType: 'CONSENT', label: 'SMS/email consent', aiQuestion: 'Is it okay if we send you a reminder by text and email?', required: true, confirmationRequired: false, sortOrder: 8, options: [] },
    ],
  });

  await db.receptionistCallLog.createMany({
    data: [
      { tenantId, clinicId: receptionistClinicId, campaignId: receptionistCampaignId, retellCallId: 'call_demo_001', callerName: 'Maria Gonzalez', callerPhone: '+14155550199', direction: 'outbound', outcome: 'BOOKED', durationSeconds: 184, sentiment: 'Positive', transcriptSummary: 'Patient was happy to return, booked a Tuesday morning cleaning at the Downtown office, consented to SMS reminders.', startedAt: new Date('2026-06-05T16:10:00Z'), endedAt: new Date('2026-06-05T16:13:04Z') },
      { tenantId, clinicId: receptionistClinicId, campaignId: receptionistCampaignId, retellCallId: 'call_demo_002', callerName: 'Daniel Cho', callerPhone: '+14155550177', direction: 'outbound', outcome: 'NOT_INTERESTED', durationSeconds: 52, sentiment: 'Neutral', transcriptSummary: 'Patient recently moved away and declined politely. No follow-up requested.', startedAt: new Date('2026-06-05T16:20:00Z'), endedAt: new Date('2026-06-05T16:20:52Z') },
      { tenantId, clinicId: receptionistClinicId, campaignId: receptionistCampaignId, retellCallId: 'call_demo_003', callerName: 'Priya Nair', callerPhone: '+14155550133', direction: 'outbound', outcome: 'ESCALATED', durationSeconds: 97, sentiment: 'Negative', transcriptSummary: 'Patient had a billing question beyond the offer; escalated to a human at the fallback number.', startedAt: new Date('2026-06-05T16:31:00Z'), endedAt: new Date('2026-06-05T16:32:37Z') },
      { tenantId, clinicId: receptionistClinicId, campaignId: receptionistCampaignId, retellCallId: 'call_demo_004', callerName: 'James Becker', callerPhone: '+14155550144', direction: 'outbound', outcome: 'OPTED_OUT', durationSeconds: 28, sentiment: 'Neutral', transcriptSummary: 'Patient asked not to be contacted again; marked do-not-contact.', startedAt: new Date('2026-06-05T16:40:00Z'), endedAt: new Date('2026-06-05T16:40:28Z') },
      { tenantId, clinicId: receptionistClinicId, campaignId: receptionistCampaignId, retellCallId: 'call_demo_005', callerName: 'Unknown', callerPhone: '+14155550155', direction: 'outbound', outcome: 'VOICEMAIL', durationSeconds: 19, sentiment: 'Neutral', transcriptSummary: 'Reached voicemail; left a short callback message.', startedAt: new Date('2026-06-05T16:48:00Z'), endedAt: new Date('2026-06-05T16:48:19Z') },
    ],
  });

  await db.receptionistAppointmentRequest.create({
    data: {
      tenantId,
      clinicId: receptionistClinicId,
      campaignId: receptionistCampaignId,
      locationId: receptionistLocationDowntownId,
      contactName: 'Maria Gonzalez',
      contactPhone: '+14155550199',
      contactEmail: 'maria.g@example.com',
      appointmentType: 'New-patient cleaning & exam',
      requestedDate: '2026-06-09',
      requestedTime: '09:30',
      bookedSlot: 'Tue Jun 9, 9:30 AM — Downtown Office',
      status: 'CONFIRMED',
      collectedData: { first_name: 'Maria', last_name: 'Gonzalez', phone: '+14155550199', email: 'maria.g@example.com', preferred_location: 'Downtown Office', insurance_provider: 'Delta Dental', consent: true },
      source: 'retell',
    },
  });

  await db.receptionistOptOut.create({
    data: { tenantId, clinicId: receptionistClinicId, contactPhone: '+14155550144', channel: 'ALL', reason: 'Requested during AI call' },
  });
}

// ---- Compliance Readiness Center baseline (idempotent, per tenant) ----------
const { seedComplianceBaseline } = await import('../server/modules/compliance/baseline');
for (const t of await db.tenant.findMany({ select: { id: true } })) {
  await seedComplianceBaseline(db, t.id);
}

// ---- Subscription commercial layer (idempotent) ----------------------------
{
  const { PLANS, ADDONS } = await import('../server/modules/subscriptions/catalog');
  const { recomputeEntitlements } = await import('../server/lib/entitlements');

  for (const plan of PLANS) {
    const planRow = await db.subscriptionPlan.upsert({
      where: { key: plan.key },
      update: { name: plan.name, description: plan.description, tier: plan.tier },
      create: { key: plan.key, name: plan.name, description: plan.description, tier: plan.tier },
    });
    for (const feature of plan.features) {
      await db.subscriptionPlanFeature.upsert({
        where: { planId_featureKey: { planId: planRow.id, featureKey: feature.featureKey } },
        update: { included: true, limitValue: feature.limitValue ?? null, note: feature.note ?? null },
        create: { planId: planRow.id, featureKey: feature.featureKey, included: true, limitValue: feature.limitValue ?? null, note: feature.note ?? null },
      });
    }
  }
  for (const addon of ADDONS) {
    await db.subscriptionAddon.upsert({
      where: { key: addon.key },
      update: { name: addon.name, description: addon.description, featureKey: addon.featureKey },
      create: { key: addon.key, name: addon.name, description: addon.description, featureKey: addon.featureKey },
    });
  }

  // Keep the dev tenant fully usable: assign Enterprise + ACTIVE.
  const enterprise = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  if (enterprise) {
    await db.tenantSubscription.upsert({
      where: { tenantId },
      update: { planId: enterprise.id, status: 'ACTIVE' },
      create: { tenantId, planId: enterprise.id, status: 'ACTIVE', startedAt: new Date() },
    });
    await recomputeEntitlements(tenantId);
  }
}

// ---- Service catalog (drives scheduling/checkout service picker) -----------
if (await db.serviceCatalogItem.count({ where: { tenantId } }) === 0) {
  await db.serviceCatalogItem.createMany({
    data: [
      { tenantId, name: 'New Patient Consultation', category: 'consultation', defaultDurationMinutes: 30, defaultAppointmentValue: 120 },
      { tenantId, name: 'Wellness Review', category: 'wellness', defaultDurationMinutes: 30, defaultAppointmentValue: 180 },
      { tenantId, name: 'Skin Resurfacing', category: 'aesthetics', defaultDurationMinutes: 60, defaultAppointmentValue: 420 },
      { tenantId, name: 'Dental Implant Assessment', category: 'dental', defaultDurationMinutes: 45, defaultAppointmentValue: 260 },
      { tenantId, name: 'Physiotherapy Session', category: 'physio', defaultDurationMinutes: 45, defaultAppointmentValue: 95 },
      { tenantId, name: 'Telehealth Follow-up', category: 'telehealth', defaultDurationMinutes: 20, defaultAppointmentValue: 80 },
    ],
  });
}

// ---- Patient intake packets (Patient Intake module) ------------------------
if (await db.patientIntakePacket.count({ where: { tenantId } }) === 0) {
  const intakeSeed = [
    { idx: 2, status: 'submitted', source: 'public', readinessScore: 92, submitted: -1 },
    { idx: 4, status: 'submitted', source: 'public', readinessScore: 78, submitted: -2 },
    { idx: 0, status: 'in_progress', source: 'staff', readinessScore: 45, submitted: null },
    { idx: 7, status: 'reviewed', source: 'public', readinessScore: 100, submitted: -5 },
    { idx: 9, status: 'draft', source: 'staff', readinessScore: 10, submitted: null },
  ];
  for (const p of intakeSeed) {
    const patient = patientPool[p.idx % patientPool.length];
    await db.patientIntakePacket.create({
      data: {
        tenantId, patientId: patient.id, status: p.status, source: p.source, readinessScore: p.readinessScore,
        createdByUserId: userId, startedAt: new Date(NOW - 6 * DAY),
        ...(p.submitted !== null ? { submittedAt: new Date(NOW + p.submitted * DAY) } : {}),
        ...(p.status === 'reviewed' ? { reviewedAt: new Date(NOW - 4 * DAY), reviewedByUserId: userId } : {}),
        metadata: { contactName: patient.name },
      },
    });
  }
}

// ---- AI recommendations (Advisory Room + Morning Briefing). Rule-based only;
// every recommendation requires human review (no autonomous execution). -------
if (await db.aIRecommendation.count({ where: { tenantId } }) === 0) {
  await db.aIRecommendation.createMany({
    data: [
      { tenantId, title: 'Re-engage 187 lapsed patients', recommendationType: 'inactive_patient_reactivation', reason: '187 patients have not visited in 90+ days and still hold marketing consent.', expectedImpact: 'Recover an estimated £9,600 in bookings', confidence: 72, requiresHumanReview: true, status: 'pending', allowedActionType: 'create_reactivation_campaign', createdBy: 'system', sourceData: { audience: 'inactive_patients', size: 187 } },
      { tenantId, title: 'Recover 3 failed deposit payments', recommendationType: 'review_failed_payment', reason: '3 deposit payments failed in the last 7 days; links can be resent.', expectedImpact: 'Protect £540 in at-risk deposits', confidence: 68, requiresHumanReview: true, status: 'pending', allowedActionType: 'resend_payment_link', createdBy: 'system', sourceData: { count: 3 } },
      { tenantId, title: 'Fill 12 open weekday slots', recommendationType: 'fill_open_slots', reason: 'Downtown has 12 unbooked weekday slots over the next 14 days.', expectedImpact: 'Up to £2,160 in additional revenue', confidence: 61, requiresHumanReview: true, status: 'pending', allowedActionType: 'create_reactivation_campaign', createdBy: 'system', sourceData: { branch: 'downtown', openSlots: 12 } },
      { tenantId, title: 'Respond to 2 negative reviews', recommendationType: 'reputation_followup', reason: '2 reviews rated ≤ 2 stars are awaiting a response.', expectedImpact: 'Protect online reputation and retention', confidence: 80, requiresHumanReview: true, status: 'pending', allowedActionType: 'review_reputation_case', createdBy: 'system', sourceData: { unresolved: 2 } },
    ],
  });
}

// ---- CRM automation rules (the 6 catalog rules, disabled by default) -------
if (await db.automationRule.count({ where: { tenantId } }) === 0) {
  const { RULE_CATALOG } = await import('../server/lib/automationRules');
  for (const t of RULE_CATALOG) {
    await db.automationRule.create({ data: { tenantId, templateKey: t.key, name: t.name, triggerType: t.triggerType, actionType: t.actionType, config: t.config, enabled: false, createdById: userId } });
  }
}

// ---- Patient portal account for the demo patient (active) ------------------
{
  const demoPatient = await db.patient.findUnique({ where: { id: patientId }, select: { email: true, phone: true } });
  await db.patientPortalAccount.upsert({
    where: { tenantId_patientId: { tenantId, patientId } },
    update: { status: 'active' },
    create: { tenantId, patientId, email: demoPatient?.email ?? null, phone: demoPatient?.phone ?? null, status: 'active' },
  });
}

// ---- Remote Monitoring Command Center (RPM demo data) -----------------------
{
  const existingReadings = await db.deviceReading.count({ where: { tenantId } });
  if (existingReadings === 0 && patientPool.length >= 6) {
    const devs = await db.device.findMany({ where: { tenantId, active: true }, select: { id: true, deviceType: true, status: true } });
    const vitals = devs.find(d => d.deviceType === 'vitals_monitor')?.id ?? null;
    const gateway = devs.find(d => d.deviceType === 'wearable_gateway')?.id ?? null;
    const offlineDev = devs.find(d => d.status === 'offline' || d.status === 'error') ?? null;
    const provider = await db.user.findFirst({ where: { tenantId, role: 'PROVIDER', active: true }, select: { id: true } });
    const assignee = provider?.id ?? userId;
    const now = Date.now();
    const ago = (mins: number) => new Date(now - mins * 60000);

    // Threshold + routing rules (org defaults + one patient-specific).
    await db.monitoringRule.createMany({ data: [
      { tenantId, scope: 'organization', readingType: 'glucose', minValue: 70, maxValue: 180, criticalMin: 54, criticalMax: 300, missedAfterHours: 12, escalationMinutes: 30, assignedRole: 'nurse', assignedToUserId: assignee, notifyChannels: 'in_app,sms', priority: 0 },
      { tenantId, scope: 'organization', readingType: 'oxygen', minValue: 92, maxValue: 100, criticalMin: 88, criticalMax: 101, missedAfterHours: 8, escalationMinutes: 15, assignedRole: 'nurse', assignedToUserId: assignee, notifyChannels: 'in_app', priority: 0 },
      { tenantId, scope: 'organization', readingType: 'blood_pressure', minValue: 90, maxValue: 140, criticalMin: 80, criticalMax: 180, missedAfterHours: 24, escalationMinutes: 45, assignedRole: 'doctor', assignedToUserId: assignee, notifyChannels: 'in_app,email', priority: 0 },
      { tenantId, scope: 'patient', patientId: patientPool[0].id, readingType: 'glucose', minValue: 80, maxValue: 160, criticalMin: 60, criticalMax: 260, missedAfterHours: 6, escalationMinutes: 20, assignedRole: 'doctor', assignedToUserId: assignee, notifyChannels: 'in_app,sms', priority: 10 },
    ] });

    // Readings — mix of normal + abnormal, captured over the last few hours.
    const readingDefs: Array<{ p: number; type: string; value: string; num: number; sec?: number; unit: string; dev: string | null; mins: number; status?: string }> = [
      { p: 0, type: 'glucose', value: '248', num: 248, unit: 'mg/dL', dev: gateway, mins: 25 },
      { p: 0, type: 'glucose', value: '176', num: 176, unit: 'mg/dL', dev: gateway, mins: 220 },
      { p: 1, type: 'oxygen', value: '89', num: 89, unit: '%', dev: vitals, mins: 40 },
      { p: 1, type: 'heart_rate', value: '104', num: 104, unit: 'bpm', dev: vitals, mins: 41 },
      { p: 2, type: 'blood_pressure', value: '186/98', num: 186, sec: 98, unit: 'mmHg', dev: vitals, mins: 65 },
      { p: 3, type: 'oxygen', value: '97', num: 97, unit: '%', dev: vitals, mins: 90 },
      { p: 3, type: 'glucose', value: '112', num: 112, unit: 'mg/dL', dev: gateway, mins: 130 },
      { p: 4, type: 'temperature', value: '38.6', num: 38.6, unit: '°C', dev: vitals, mins: 150 },
      { p: 5, type: 'blood_pressure', value: '124/79', num: 124, sec: 79, unit: 'mmHg', dev: vitals, mins: 175 },
      { p: 2, type: 'heart_rate', value: '72', num: 72, unit: 'bpm', dev: vitals, mins: 200 },
      { p: 0, type: 'glucose', value: '205', num: 205, unit: 'mg/dL', dev: gateway, mins: 300 },
      { p: 4, type: 'oxygen', value: '95', num: 95, unit: '%', dev: vitals, mins: 360 },
    ];
    const createdReadings: { id: string; p: number; type: string; value: string; unit: string }[] = [];
    for (const r of readingDefs) {
      const pt = patientPool[r.p];
      // Flow each reading through the real adapter normalization (same path a
      // provider webhook uses) so seeded data is pipeline-produced, not hand-built.
      const { readings: norm } = normalizeWebhook('manual', { readings: [{ readingType: r.type, value: r.value, numericValue: r.num, valueSecondary: r.sec, unit: r.unit }] });
      const nr = norm[0];
      const reading = await db.deviceReading.create({
        data: { tenantId, patientId: pt.id, branchId: pt.branchId, deviceId: r.dev, readingType: nr.readingType, value: nr.value, numericValue: nr.numericValue ?? null, valueSecondary: nr.valueSecondary ?? null, unit: nr.unit ?? r.unit, capturedAt: ago(r.mins), receivedAt: ago(r.mins - 1), source: 'device', validationStatus: 'valid', rawPayload: { raw: r.value, deviceTs: ago(r.mins).toISOString() } },
        select: { id: true },
      });
      createdReadings.push({ id: reading.id, p: r.p, type: r.type, value: r.value, unit: r.unit });
    }

    // Alerts — severity DECIDED BY THE ENGINE (evaluateSeverity), not hand-coded.
    let critCount = 0;
    for (let i = 0; i < createdReadings.length; i++) {
      const r = createdReadings[i];
      const rd = readingDefs[i];
      const pt = patientPool[r.p];
      const { severity, reason } = evaluateSeverity(rd.type, rd.num, null);
      if (severity === 'normal') continue;
      const status = severity === 'critical' && critCount === 0 ? 'open' : (i % 3 === 0 ? 'acknowledged' : 'open');
      if (severity === 'critical') critCount++;
      await db.readingAlert.create({ data: { tenantId, patientId: pt.id, branchId: pt.branchId, readingId: r.id, severity, alertType: 'abnormal_reading', status, generatedReason: reason, assignedToUserId: severity === 'critical' ? assignee : (i % 2 ? assignee : null), acknowledgedAt: status !== 'open' ? ago(15) : null } });
    }
    // Missed reading + device-offline alerts (operational, no reading attached).
    await db.readingAlert.create({ data: { tenantId, patientId: patientPool[1].id, branchId: patientPool[1].branchId, severity: 'high', alertType: 'missed_reading', status: 'open', generatedReason: 'No glucose reading received in 14h for a high-risk patient (expected every 12h).', assignedToUserId: assignee } });
    if (offlineDev) {
      await db.readingAlert.create({ data: { tenantId, patientId: patientPool[5].id, branchId: patientPool[5].branchId, deviceId: offlineDev.id, severity: 'warning', alertType: 'device_offline', status: 'open', generatedReason: 'Monitoring device is offline — patient readings are not being received.' } });
    }

    // Notification + delivery log (consent-checked).
    const firstAlert = await db.readingAlert.findFirst({ where: { tenantId, severity: 'critical' }, select: { id: true, patientId: true } });
    await db.notificationEvent.createMany({ data: [
      { tenantId, alertId: firstAlert?.id ?? null, patientId: firstAlert?.patientId ?? null, recipientType: 'doctor', recipientUserId: assignee, channel: 'in_app', status: 'delivered', attempts: 1, consentChecked: true, consentResult: 'not_required', sentAt: ago(24) },
      { tenantId, alertId: firstAlert?.id ?? null, patientId: firstAlert?.patientId ?? null, recipientType: 'doctor', recipientUserId: assignee, channel: 'sms', status: 'sent', attempts: 1, consentChecked: true, consentResult: 'not_required', sentAt: ago(23) },
      { tenantId, patientId: patientPool[0].id, recipientType: 'patient', recipientLabel: patientPool[0].name, channel: 'sms', status: 'delivered', attempts: 1, consentChecked: true, consentResult: 'granted', sentAt: ago(22) },
      { tenantId, patientId: patientPool[1].id, recipientType: 'patient', recipientLabel: patientPool[1].name, channel: 'sms', status: 'failed', attempts: 3, failureReason: 'Carrier rejected — invalid number', consentChecked: true, consentResult: 'granted', sentAt: ago(20) },
      { tenantId, recipientType: 'nurse', recipientLabel: 'Nurse queue', channel: 'in_app', status: 'delivered', attempts: 1, consentChecked: true, consentResult: 'not_required', sentAt: ago(18) },
      { tenantId, patientId: patientPool[3].id, recipientType: 'patient', recipientLabel: patientPool[3].name, channel: 'email', status: 'queued', attempts: 0, consentChecked: true, consentResult: 'granted' },
    ] });

    // Morning briefing signals for today.
    const today = new Date(); today.setHours(6, 0, 0, 0);
    await db.morningBriefingSignal.createMany({ data: [
      { tenantId, signalType: 'critical_review', title: '2 patients need doctor review', detail: 'Critical glucose and blood-pressure readings are open and unresolved.', severity: 'critical', metricValue: 2, patientId: patientPool[0].id, forDate: today },
      { tenantId, signalType: 'nurse_followup', title: 'Nurse follow-up queue: 2 alerts', detail: 'Low oxygen and elevated temperature awaiting nurse action.', severity: 'warning', metricValue: 2, forDate: today },
      { tenantId, signalType: 'missed_high_risk', title: '1 missed reading from a high-risk patient', detail: 'No glucose reading in 14h — outreach recommended.', severity: 'warning', metricValue: 1, patientId: patientPool[1].id, forDate: today },
      { tenantId, signalType: 'offline_impact', title: '1 monitoring device offline', detail: 'A patient monitoring device is offline and not reporting.', severity: 'warning', metricValue: 1, forDate: today },
      { tenantId, signalType: 'trending_worse', title: '1 patient trending worse', detail: 'Repeated above-range glucose readings over the last 5 hours.', severity: 'warning', metricValue: 1, patientId: patientPool[0].id, forDate: today },
      { tenantId, signalType: 'rpm_opportunity', title: 'RPM billing opportunity', detail: '4 enrolled patients have ≥16 monitoring days this cycle — eligible for RPM reimbursement review.', severity: 'info', metricValue: 4, forDate: today },
    ] });
    console.log('[seed] remote monitoring: seeded readings/alerts/notifications/briefing');

    // ── Real connected-care records: enrollments, consent, RPM device-days ──
    const periodStart = new Date(); periodStart.setHours(0, 0, 0, 0); periodStart.setDate(periodStart.getDate() - 29);
    const periodEnd = new Date();
    for (const i of [0, 1, 3, 4]) {
      const pt = patientPool[i];
      await db.patientDeviceEnrollment.upsert({
        where: { tenantId_patientId_providerKey: { tenantId, patientId: pt.id, providerKey: 'manual' } },
        create: { tenantId, patientId: pt.id, branchId: pt.branchId, providerKey: 'manual', programType: 'rpm', status: 'active', externalRef: `EXT-${i}` },
        update: { status: 'active' },
      });
      await db.patientConsent.upsert({
        where: { tenantId_patientId_consentType: { tenantId, patientId: pt.id, consentType: 'rpm' } },
        create: { tenantId, patientId: pt.id, consentType: 'rpm', granted: true, method: 'written', grantedAt: new Date(Date.now() - 30 * 86400000) },
        update: { granted: true },
      });
    }
    // Give patient[0] a real 18-day reading history so RPM device-days qualify.
    for (let d = 1; d <= 18; d++) {
      const captured = new Date(); captured.setHours(8, 0, 0, 0); captured.setDate(captured.getDate() - d);
      await db.deviceReading.create({ data: { tenantId, patientId: patientPool[0].id, branchId: patientPool[0].branchId, deviceId: gateway, readingType: 'glucose', value: String(120 + (d % 5) * 6), numericValue: 120 + (d % 5) * 6, unit: 'mg/dL', capturedAt: captured, receivedAt: captured, source: 'device', validationStatus: 'valid' } });
    }
    // RPM readiness: patient[0] has the review minutes + signoff to reach READY.
    await db.rPMBillingReadiness.upsert({
      where: { tenantId_patientId_periodStart: { tenantId, patientId: patientPool[0].id, periodStart } },
      create: { tenantId, patientId: patientPool[0].id, periodStart, periodEnd, readingDays: 18, reviewMinutes: 24, communicationFlag: true, providerSignoffUserId: assignee, providerSignoffAt: new Date(), status: 'READY' },
      update: { reviewMinutes: 24, communicationFlag: true, providerSignoffUserId: assignee, providerSignoffAt: new Date() },
    });
    // A real inbound sync-log entry for the manual import of these readings.
    await db.deviceProviderSyncLog.create({ data: { tenantId, providerKind: 'device', providerKey: 'manual', direction: 'inbound', event: 'sync', status: 'processed', signatureValid: null, readingsIngested: createdReadings.length + 18, alertsCreated: 0, message: `Manual import normalized ${createdReadings.length + 18} reading(s)`, payload: { source: 'seed', count: createdReadings.length + 18 } } });
    console.log('[seed] connected-care: enrollments + consent + RPM device-days + sync log');
  }
}

// ---- Connected Care provider registry (real catalog; not fake "active") -----
for (const def of [
  { providerKey: 'stedi', displayName: 'Stedi', category: 'INSURANCE', mode: 'sandbox', status: 'SANDBOX' },
  { providerKey: 'optum', displayName: 'Optum', category: 'INSURANCE', mode: 'sandbox', status: 'NOT_CONFIGURED' },
  { providerKey: 'availity', displayName: 'Availity', category: 'INSURANCE', mode: 'sandbox', status: 'NOT_CONFIGURED' },
]) {
  const existing = await db.insuranceProvider.findFirst({ where: { tenantId, providerKey: def.providerKey } });
  if (!existing) await db.insuranceProvider.create({ data: { tenantId, ...def } });
}
for (const def of [
  { providerKey: 'dexcom', displayName: 'Dexcom', category: 'DIRECT_API', status: 'NOT_CONFIGURED' },
  { providerKey: 'withings', displayName: 'Withings', category: 'DIRECT_API', status: 'NOT_CONFIGURED' },
  { providerKey: 'validic', displayName: 'Validic', category: 'AGGREGATOR', status: 'NOT_CONFIGURED' },
  { providerKey: 'terra', displayName: 'Terra', category: 'AGGREGATOR', status: 'NOT_CONFIGURED' },
  { providerKey: 'tenovi', displayName: 'Tenovi', category: 'RPM_VENDOR', status: 'NOT_CONFIGURED' },
  { providerKey: 'manual', displayName: 'Manual entry', category: 'MANUAL', status: 'ACTIVE' },
]) {
  const existing = await db.deviceProvider.findFirst({ where: { tenantId, providerKey: def.providerKey } });
  if (!existing) await db.deviceProvider.create({ data: { tenantId, mode: 'sandbox', ...def } });
}
console.log('[seed] connected-care provider registry');

// Seed the first PLATFORM_OWNER from secure env vars only (no weak default).
{
  const { ensurePlatformOwnerSeed } = await import('../server/lib/platformAuth');
  const result = await ensurePlatformOwnerSeed();
  console.log(`[seed] platform owner: ${result.reason}`);
}

await db.$disconnect();
