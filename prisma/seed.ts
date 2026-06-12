import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../server/generated/prisma/client';
import { generatePasswordHash } from '../server/lib/security';

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
  create: { id: tenantId, name: 'CareCommand Demo Clinics', slug: 'carecommand-demo' },
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
    displayName: 'Demo Admin',
    role: 'OWNER',
    passwordHash: await generatePasswordHash('ChangeMe123!'),
    active: true,
  },
  create: {
    id: userId,
    tenantId,
    email: 'admin@carecommand.ai',
    displayName: 'Demo Admin',
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
    lastName: 'Live',
    email: 'charlotte.live@carecommand.local',
    phone: '+44 7700 900100',
    lifecycleStage: 'ACTIVE',
    churnRisk: 12,
    lifetimeValue: 4250,
    tags: ['live-db', 'wellness'],
  },
});

for (const consent of [
  { purpose: 'EMAIL' as const, granted: true },
  { purpose: 'MARKETING' as const, granted: true },
]) {
  const existing = await db.consentEvent.findFirst({ where: { tenantId, patientId, purpose: consent.purpose } });
  if (!existing) await db.consentEvent.create({ data: { tenantId, patientId, source: 'seed', ...consent } });
}

const appointment = await db.appointment.findFirst({ where: { tenantId, patientId, service: 'Live Wellness Review' } });
if (!appointment) {
  await db.appointment.create({
    data: {
      tenantId, branchId, patientId, service: 'Live Wellness Review',
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

const review = await db.review.findFirst({ where: { tenantId, patientId, text: 'Live database review: smooth booking and thoughtful follow-up.' } });
if (!review) await db.review.create({ data: { tenantId, branchId, patientId, rating: 5, text: 'Live database review: smooth booking and thoughtful follow-up.', platform: 'google', sentiment: 'positive' } });

const report = await db.partnerReport.findFirst({ where: { tenantId, patientId, reportType: 'Live partner wellness report' } });
if (!report) await db.partnerReport.create({ data: { tenantId, branchId, patientId, reportType: 'Live partner wellness report', partner: 'TDL London', urgency: 'routine', status: 'result-received', summary: 'Live operational document ready for provider review.', reviewedAt: new Date('2026-06-02T10:20:00Z'), reviewedByUserId: userId } });

const task = await db.staffTask.findFirst({ where: { tenantId, title: 'Live DB: confirm wellness follow-up' } });
if (!task) await db.staffTask.create({ data: { tenantId, branchId, assignedToId: userId, title: 'Live DB: confirm wellness follow-up', priority: 'medium', dueAt: new Date('2026-06-01T12:00:00Z') } });

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

const conversation = await db.conversation.findFirst({ where: { tenantId, patientId, latestMessage: 'Live DB enquiry: can I book a wellness review this week?' } });
if (!conversation) await db.conversation.create({
  data: {
    tenantId,
    branchId,
    patientId,
    channel: 'WHATSAPP',
    status: 'unread',
    intent: 'Booking inquiry',
    latestMessage: 'Live DB enquiry: can I book a wellness review this week?',
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

for (const playbook of [
  { key: 'empty-slot-rescue', name: 'Empty Slot Rescue', description: 'Match released capacity with consent-safe customer outreach.' },
  { key: 'missed-call-recovery', name: 'Missed Call Recovery', description: 'Recover missed inquiries with channel-aware follow-up.' },
  { key: 'customer-winback', name: 'Customer Winback', description: 'Escalate or automate reactivation based on customer value.' },
]) {
  await db.autopilotPlaybook.upsert({
    where: { tenantId_key: { tenantId, key: playbook.key } },
    update: {},
    create: { tenantId, ...playbook, status: 'LIVE', config: { autonomyLevel: 2 } },
  });
}

const slotFillPlaybook = await db.autopilotPlaybook.findUniqueOrThrow({
  where: { tenantId_key: { tenantId, key: 'empty-slot-rescue' } },
});

const pendingApproval = await db.autopilotApproval.findFirst({
  where: { tenantId, title: 'Activate Westside weekday slot-fill offer', status: 'PENDING' },
});

if (!pendingApproval) {
  await db.autopilotApproval.create({
    data: {
      tenantId,
      playbookId: slotFillPlaybook.id,
      title: 'Activate Westside weekday slot-fill offer',
      reason: '31 empty slots detected · estimated £6,200 at risk',
      payload: { scope: 'Send to 84 matched customers', value: '£6,200' },
      confidence: 91,
    },
  });
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
  { id: patientId, branchId, name: 'Charlotte Live' },
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

const policySeeds = [
  { patientId: patientPool[0].id, branchId: patientPool[0].branchId, payerName: 'Cigna', planName: 'Cigna Choice Gold', memberId: 'CIG-428194', groupNumber: 'GRP-9012', subscriberName: 'Charlotte Live' },
  { patientId: patientPool[1].id, branchId: patientPool[1].branchId, payerName: 'Aetna', planName: 'Aetna Core Plus', memberId: 'AET-110293', groupNumber: 'GRP-2411', subscriberName: 'Amelia Hughes' },
  { patientId: patientPool[2].id, branchId: patientPool[2].branchId, payerName: 'UnitedHealthcare', planName: 'UHC Balance Plan', memberId: 'UHC-551028', groupNumber: 'GRP-7740', subscriberName: 'Daniel Okoro' },
];
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
        verificationStatus: 'pending',
        active: true,
      },
    });
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
      { tenantId, providerKey: 'mock', displayName: 'Mock Payments', mode: 'mock', status: 'connected', baseUrl: null, connectedAt: new Date(NOW - DAY), lastSyncAt: new Date(NOW - DAY / 2), configuration: { description: 'Safe fallback for local demo runs.' } },
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

await db.$disconnect();
