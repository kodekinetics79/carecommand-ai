import 'dotenv/config';
import { createHash, scryptSync } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../server/generated/prisma/client';
import { syntheticProfiles } from './synthetic/profileManifest';
import { assertSyntheticSeedTarget } from './synthetic/seedSafety';
import { seedGrowthDemo } from './synthetic/growthDemo';
import { seedReceptionistDemo } from './synthetic/receptionistDemo';

const target = assertSyntheticSeedTarget({
  nodeEnv: process.env.NODE_ENV,
  profile: process.env.SYNTHETIC_PROFILE,
  connectionString: process.env.SYNTHETIC_DATABASE_URL ?? process.env.DATABASE_MIGRATION_URL,
  confirmation: process.env.CONFIRM_SYNTHETIC_DATABASE,
});
const profile = syntheticProfiles[target.profile];
const { connectionString, databaseName } = target;

// The growth demo layer reuses the PRODUCTION entitlement resolver and the
// PRODUCTION attribution job rather than reimplementing either. Both modules
// import server/lib/db, which builds its singleton from env.DATABASE_URL at
// import time. Rebinding DATABASE_URL to the already-verified disposable target
// before those (dynamic) imports means that singleton can only ever point at
// the synthetic database, even though every call site here passes its own
// client explicitly.
process.env.DATABASE_URL = connectionString;

// The receptionist demo layer deploys through the PRODUCTION deploy path, which
// refuses to run with no voice provider configured — correctly. A synthetic
// seed is a rehearsal by definition, so default to the mock provider unless the
// caller supplied its own. The env schema refuses a mock Retell key outside the
// demo profile, so this cannot leak into a pilot.
process.env.RETELL_API_KEY ??= `mock_synthetic_${databaseName}`.slice(0, 60);
process.env.RETELL_FROM_NUMBER ??= '+15550100000';

// Inactivity windows are evaluated against the API's wall clock, so a
// `lastVisitAt` pinned to the controlled clock would fall out of the 30-60 /
// 60-90 / 90-180 bands as soon as real time moved past it. Window-relative
// timestamps are anchored here instead; set SYNTHETIC_DEMO_CLOCK to pin it.
const demoClockRaw = process.env.SYNTHETIC_DEMO_CLOCK;
if (demoClockRaw && Number.isNaN(Date.parse(demoClockRaw))) {
  throw new Error('SYNTHETIC_DEMO_CLOCK must be an ISO-8601 timestamp');
}
const demoClock = demoClockRaw ? new Date(demoClockRaw) : new Date();

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const now = new Date(profile.controlledClock);
const day = 86_400_000;

function stableUuid(scope: string, index: number): string {
  const hex = createHash('sha256').update(`${profile.fixedSeed}:${profile.profile}:${scope}:${index}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function deterministicPasswordHash(password: string): string {
  const salt = createHash('sha256').update(`${profile.fixedSeed}:${profile.profile}:password`).digest('hex').slice(0, 32);
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function phoneFor(scope: number, index: number): string {
  return `+1555${String(scope).padStart(2, '0')}${String(index).padStart(5, '0')}`;
}

const userRoles = ['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'] as const;
const lifecycleStages = ['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'RETAINED'] as const;
const appointmentStatuses = ['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST'] as const;
const callOutcomes = ['IN_PROGRESS', 'BOOKED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'ESCALATED', 'OPTED_OUT', 'FAILED'] as const;

async function seed(): Promise<void> {
  const existingTenantCount = await db.tenant.count();
  if (existingTenantCount !== 0) {
    throw new Error(`Disposable target is not empty (${existingTenantCount} tenants); drop and recreate it instead of deleting audit history`);
  }

  const passwordHash = deterministicPasswordHash('SyntheticOnly!2026');
  const tenantIds: string[] = [];
  const tenantStatuses: string[] = [];
  const branchIds: string[] = [];
  const receptionistClinicIds: string[] = [];
  const branchTenant: string[] = [];
  const userIds: string[] = [];
  const userTenant: string[] = [];
  const userBranch: string[] = [];
  const patientIds: string[] = [];
  const patientTenant: string[] = [];
  const patientBranch: string[] = [];
  const appointmentIds: string[] = [];

  const tenants: Prisma.TenantCreateManyInput[] = [];
  for (let index = 0; index < profile.tenants; index += 1) {
    const id = stableUuid('tenant', index);
    const status = profile.profile === 'EDGE'
      ? ['active', 'suspended', 'cancelled', 'active', 'suspended'][index % 5]
      : (profile.profile === 'PILOT' || profile.profile === 'TIER1') && index === profile.tenants - 1 ? 'suspended' : 'active';
    tenantIds.push(id);
    tenantStatuses.push(status);
    tenants.push({
      id,
      name: `Synthetic ${profile.profile} Health Group ${index + 1}`,
      slug: `syn-${profile.profile.toLowerCase()}-${index + 1}`,
      status,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.tenant.createMany({ data: tenants });
  await db.platformUser.createMany({ data: [
    {
      id: stableUuid('platform-user', 0), email: 'synthetic.platform.owner@example.test', name: 'Synthetic Platform Owner',
      passwordHash, role: 'PLATFORM_OWNER', status: 'active', passwordChangedAt: now, createdAt: now, updatedAt: now,
    },
    {
      id: stableUuid('platform-user', 1), email: 'synthetic.platform.support@example.test', name: 'Synthetic Platform Support',
      passwordHash, role: 'PLATFORM_SUPPORT', status: 'active', passwordChangedAt: now, createdAt: now, updatedAt: now,
    },
  ] });

  const branches: Prisma.BranchCreateManyInput[] = [];
  const clinics: Prisma.ReceptionistClinicCreateManyInput[] = [];
  for (let index = 0; index < profile.clinics; index += 1) {
    const tenantIndex = index % tenantIds.length;
    const branchId = stableUuid('branch', index);
    const clinicId = stableUuid('receptionist-clinic', index);
    branchIds.push(branchId);
    receptionistClinicIds.push(clinicId);
    branchTenant.push(tenantIds[tenantIndex]);
    branches.push({
      id: branchId,
      tenantId: tenantIds[tenantIndex],
      name: `Synthetic Clinic ${index + 1}`,
      location: `${100 + index} Example Avenue, Test City, NY 10001`,
      timezone: index % 2 === 0 ? 'America/New_York' : 'America/Chicago',
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    clinics.push({
      id: clinicId,
      tenantId: tenantIds[tenantIndex],
      name: `Synthetic Reception Clinic ${index + 1}`,
      phone: phoneFor(10, index),
      website: `https://clinic-${index + 1}.example.test`,
      addressLine: `${100 + index} Example Avenue, Test City, NY 10001`,
      timezone: index % 2 === 0 ? 'America/New_York' : 'America/Chicago',
      humanFallbackNumber: phoneFor(90, index),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.branch.createMany({ data: branches });
  await db.receptionistClinic.createMany({ data: clinics });

  const users: Prisma.UserCreateManyInput[] = [];
  for (let index = 0; index < profile.users; index += 1) {
    const tenantIndex = index % tenantIds.length;
    const candidateBranches = branchIds.filter((_, branchIndex) => branchTenant[branchIndex] === tenantIds[tenantIndex]);
    const role = userRoles[index % userRoles.length];
    const homeBranchId = candidateBranches[index % candidateBranches.length];
    // The OWNER is the demo persona and owns the whole tenant: a branch
    // RESTRICTION would hide every tenant-wide campaign from them, because
    // branch scope is an exact match that deliberately fails closed on
    // null-branch records. The owner keeps a primary clinic association below
    // but carries no branch restriction; everyone else stays branch-assigned
    // so the demo can also show scoping working.
    const branchId = role === 'OWNER' ? null : homeBranchId;
    const id = stableUuid('user', index);
    userIds.push(id);
    userTenant.push(tenantIds[tenantIndex]);
    userBranch.push(homeBranchId);
    users.push({
      id,
      tenantId: tenantIds[tenantIndex],
      branchId,
      email: `synthetic.user.${index + 1}@example.test`,
      displayName: `Synthetic ${role} ${index + 1}`,
      role: userRoles[index % userRoles.length],
      passwordHash,
      active: index % 17 !== 16,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.user.createMany({ data: users });
  await db.userClinicAccess.createMany({
    data: userIds.map((userId, index) => ({
      id: stableUuid('user-clinic', index), tenantId: userTenant[index], userId, branchId: userBranch[index], isPrimary: true, createdAt: now,
    })),
  });

  const patients: Prisma.PatientCreateManyInput[] = [];
  for (let index = 0; index < profile.patients; index += 1) {
    const branchIndex = index % branchIds.length;
    const id = stableUuid('patient', index);
    patientIds.push(id);
    patientTenant.push(branchTenant[branchIndex]);
    patientBranch.push(branchIds[branchIndex]);
    const sameName = profile.profile === 'EDGE' && index < 4;
    patients.push({
      id,
      tenantId: branchTenant[branchIndex],
      branchId: branchIds[branchIndex],
      externalRef: `SYN-${profile.profile}-${String(index + 1).padStart(6, '0')}`,
      firstName: sameName ? 'Alex' : `Synthetic${index + 1}`,
      lastName: sameName ? 'Example' : `Patient${index + 1}`,
      dateOfBirth: new Date(Date.UTC(1950 + (index % 60), index % 12, 1 + (index % 27))),
      email: `synthetic.patient.${index + 1}@example.test`,
      phone: phoneFor(20 + (index % 10), index),
      lifecycleStage: lifecycleStages[index % lifecycleStages.length],
      eligibilityStatus: index % 5 === 0 ? 'self_pay' : index % 7 === 0 ? 'inactive' : 'active',
      lifetimeValue: new Prisma.Decimal(100 + (index % 50) * 25),
      outstandingBalance: new Prisma.Decimal(index % 6 === 0 ? 75 : 0),
      churnRisk: (index * 13) % 100,
      tags: [profile.profile.toLowerCase(), index % 11 === 0 ? 'dnc' : 'standard'],
      createdAt: new Date(now.getTime() - (index % 365) * day),
      updatedAt: now,
    });
  }
  await db.patient.createMany({ data: patients });
  const portalPatientIndexes = tenantIds.map(tenantId => patientTenant.findIndex(value => value === tenantId));
  await db.patientPortalAccount.createMany({
    data: portalPatientIndexes.map((patientIndex, index) => ({
      id: stableUuid('portal-account', index),
      tenantId: patientTenant[patientIndex],
      patientId: patientIds[patientIndex],
      email: `synthetic.patient.${patientIndex + 1}@example.test`,
      phone: phoneFor(20 + (patientIndex % 10), patientIndex),
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    })),
  });

  const packets: Prisma.PatientIntakePacketCreateManyInput[] = [];
  const documents: Prisma.PatientIntakeDocumentCreateManyInput[] = [];
  for (let index = 0; index < profile.documents; index += 1) {
    const patientIndex = index % patientIds.length;
    const packetId = stableUuid('intake-packet', index);
    packets.push({
      id: packetId, tenantId: patientTenant[patientIndex], patientId: patientIds[patientIndex],
      status: index % 3 === 0 ? 'submitted' : 'draft', source: 'synthetic_profile', readinessScore: index % 3 === 0 ? 100 : 50,
      metadata: { synthetic: true, scenario: `DOC-${index + 1}` }, createdAt: now, updatedAt: now,
    });
    documents.push({
      id: stableUuid('intake-document', index), tenantId: patientTenant[patientIndex], packetId,
      documentType: index % 2 === 0 ? 'insurance_card_front' : 'intake_attachment',
      fileName: `synthetic-document-${index + 1}.pdf`, mimeType: 'application/pdf', fileSize: 1024 + index,
      storageProvider: 'metadata_only', fileHash: createHash('sha256').update(`synthetic-document-${index + 1}`).digest('hex'),
      status: 'metadata_only', createdAt: now, updatedAt: now,
    });
  }
  for (let offset = 0; offset < packets.length; offset += 500) {
    await db.patientIntakePacket.createMany({ data: packets.slice(offset, offset + 500) });
    await db.patientIntakeDocument.createMany({ data: documents.slice(offset, offset + 500) });
  }

  const appointments: Prisma.AppointmentCreateManyInput[] = [];
  for (let index = 0; index < profile.appointments; index += 1) {
    const patientIndex = index % patientIds.length;
    const startsAt = new Date(now.getTime() + ((index % 180) - 90) * day + (8 + (index % 9)) * 3_600_000);
    const id = stableUuid('appointment', index);
    appointmentIds.push(id);
    appointments.push({
      id,
      tenantId: patientTenant[patientIndex],
      branchId: patientBranch[patientIndex],
      patientId: patientIds[patientIndex],
      providerRef: `SYN-PROVIDER-${(index % Math.max(1, profile.users)) + 1}`,
      service: ['New patient visit', 'Follow-up', 'Annual wellness', 'Dental review'][index % 4],
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: appointmentStatuses[index % appointmentStatuses.length],
      channel: index % 9 === 0 ? 'VIDEO' : index % 2 === 0 ? 'SMS' : 'EMAIL',
      value: new Prisma.Decimal(90 + (index % 8) * 20),
      noShowRisk: (index * 7) % 100,
      notes: 'Synthetic scenario data; not a real patient appointment.',
      createdAt: new Date(startsAt.getTime() - 14 * day),
      updatedAt: now,
    });
  }
  for (let offset = 0; offset < appointments.length; offset += 500) {
    await db.appointment.createMany({ data: appointments.slice(offset, offset + 500) });
  }

  const calls: Prisma.ReceptionistCallLogCreateManyInput[] = [];
  for (let index = 0; index < profile.calls; index += 1) {
    const clinicIndex = index % receptionistClinicIds.length;
    const tenantId = branchTenant[clinicIndex];
    calls.push({
      id: stableUuid('call', index), tenantId, clinicId: receptionistClinicIds[clinicIndex],
      retellCallId: `synthetic-${profile.profile.toLowerCase()}-call-${String(index + 1).padStart(6, '0')}`,
      callerName: `Synthetic Caller ${index + 1}`, callerPhone: phoneFor(40 + (index % 10), index),
      direction: index % 3 === 0 ? 'inbound' : 'outbound', outcome: callOutcomes[index % callOutcomes.length],
      durationSeconds: 30 + (index % 300),
      startedAt: new Date(now.getTime() - (index % 30) * day), endedAt: new Date(now.getTime() - (index % 30) * day + 120_000),
      createdAt: new Date(now.getTime() - (index % 30) * day), updatedAt: now,
    });
  }
  for (let offset = 0; offset < calls.length; offset += 500) {
    await db.receptionistCallLog.createMany({ data: calls.slice(offset, offset + 500) });
  }

  const payments: Prisma.PaymentRequestCreateManyInput[] = [];
  for (let index = 0; index < profile.paymentRequests; index += 1) {
    const patientIndex = index % patientIds.length;
    payments.push({
      id: stableUuid('payment-request', index), tenantId: patientTenant[patientIndex], branchId: patientBranch[patientIndex],
      patientId: patientIds[patientIndex], appointmentId: appointmentIds[index % appointmentIds.length],
      amount: new Prisma.Decimal(50 + (index % 10) * 15), currency: 'USD',
      status: ['pending', 'paid', 'failed', 'refunded'][index % 4], reason: 'Synthetic pilot payment', mode: 'simulator',
      providerReference: `syn_pay_${profile.profile.toLowerCase()}_${index + 1}`, dueAt: new Date(now.getTime() + (index % 14) * day),
      publicToken: stableUuid('payment-token', index), linkExpiresAt: new Date(now.getTime() + 7 * day), createdAt: now, updatedAt: now,
    });
  }
  await db.paymentRequest.createMany({ data: payments });

  const notifications: Prisma.NotificationEventCreateManyInput[] = [];
  for (let index = 0; index < profile.notifications; index += 1) {
    const patientIndex = index % patientIds.length;
    notifications.push({
      id: stableUuid('notification', index), tenantId: patientTenant[patientIndex], patientId: patientIds[patientIndex],
      recipientType: index % 2 === 0 ? 'patient' : 'care_coordinator', recipientLabel: `Synthetic recipient ${index + 1}`,
      channel: ['in_app', 'email', 'sms', 'push'][index % 4], status: ['queued', 'sent', 'delivered', 'failed'][index % 4],
      attempts: index % 3, failureReason: index % 4 === 3 ? 'synthetic provider failure' : null,
      consentChecked: true, consentResult: index % 11 === 0 ? 'denied' : 'granted', createdAt: new Date(now.getTime() - (index % 30) * day),
    });
  }
  for (let offset = 0; offset < notifications.length; offset += 500) {
    await db.notificationEvent.createMany({ data: notifications.slice(offset, offset + 500) });
  }

  const audits: Prisma.AuditEventCreateManyInput[] = [];
  for (let index = 0; index < profile.auditEvents; index += 1) {
    const userIndex = index % userIds.length;
    audits.push({
      id: stableUuid('audit-event', index), tenantId: userTenant[userIndex], actorUserId: userIds[userIndex],
      action: ['synthetic.patient.viewed', 'synthetic.appointment.updated', 'synthetic.call.processed', 'synthetic.payment.reviewed'][index % 4],
      resource: ['patient', 'appointment', 'receptionistCall', 'paymentRequest'][index % 4],
      resourceId: [patientIds[index % patientIds.length], appointmentIds[index % appointmentIds.length]][index % 2],
      requestId: `synthetic-request-${index + 1}`, metadata: { synthetic: true, profile: profile.profile },
      occurredAt: new Date(now.getTime() - (index % 180) * day),
    });
  }
  for (let offset = 0; offset < audits.length; offset += 500) {
    await db.auditEvent.createMany({ data: audits.slice(offset, offset + 500) });
  }

  await db.integration.createMany({
    data: tenantIds.flatMap((tenantId, tenantIndex) => [
      { id: stableUuid(`integration-${tenantIndex}`, 0), tenantId, key: 'synthetic-payments', name: 'Synthetic Payment Simulator', category: 'Payments', status: 'CONNECTED' as const, config: { mode: 'simulator', synthetic: true }, lastSyncAt: now, createdAt: now, updatedAt: now },
      { id: stableUuid(`integration-${tenantIndex}`, 1), tenantId, key: 'synthetic-eligibility', name: 'Synthetic Eligibility Simulator', category: 'Insurance', status: tenantIndex % 3 === 0 ? 'ERROR' as const : 'CONNECTED' as const, config: { mode: 'simulator', synthetic: true }, lastSyncAt: now, createdAt: now, updatedAt: now },
    ]),
  });

  await db.tenantBilling.createMany({
    data: tenantIds.map((tenantId, index) => ({
      id: stableUuid('tenant-billing', index), tenantId, cycle: index % 2 ? 'annual' : 'monthly', currency: 'USD',
      mrr: new Prisma.Decimal(499 + index * 250), paymentStatus: index % 4 === 3 ? 'failed' : 'ok',
      renewalDate: new Date(now.getTime() + 30 * day), provider: 'simulator', externalRef: `syn_sub_${index + 1}`, createdAt: now, updatedAt: now,
    })),
  });

  // Everything above is the operational spine. The Growth module needs a
  // subscription, an inactivity history and its own records before any of its
  // screens can show a working clinic; that layer is seeded here, on top of the
  // records it references.
  const growth = await seedGrowthDemo({
    db, profile, now, demoClock, stableUuid,
    tenantIds, tenantStatuses, branchIds, branchTenant,
    userIds, userTenant, patientIds, patientTenant, patientBranch,
  });

  // The receptionist spine: a mapped location, a named agent, a campaign with
  // real intake, a bookable service and provider availability — then deploy,
  // verify and activate through the production paths, so a demo tenant opens
  // Studio on a working front desk rather than four empty states.
  const receptionist = await seedReceptionistDemo({
    db, now, demoClock, stableUuid,
    clinicIds: receptionistClinicIds, branchIds, branchTenant, userIds, userTenant,
  });

  const counts = {
    profile: profile.profile,
    database: databaseName,
    tenants: await db.tenant.count(),
    clinics: await db.branch.count(),
    users: await db.user.count(),
    platformUsers: await db.platformUser.count(),
    portalAccounts: await db.patientPortalAccount.count(),
    patients: await db.patient.count(),
    appointments: await db.appointment.count(),
    calls: await db.receptionistCallLog.count(),
    paymentRequests: await db.paymentRequest.count(),
    documents: await db.patientIntakeDocument.count(),
    notifications: await db.notificationEvent.count(),
    auditEvents: await db.auditEvent.count(),
    controlledClock: profile.controlledClock,
    demoClock: demoClock.toISOString(),
    fixedSeed: profile.fixedSeed,
    growth,
    receptionist,
  };
  console.log(JSON.stringify(counts));
}

seed()
  .finally(async () => db.$disconnect())
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
