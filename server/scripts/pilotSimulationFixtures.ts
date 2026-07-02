export type PilotSimulationCase = {
  clinicName: string;
  slug: string;
  branchNames: string[];
  patientCsv: string;
  appointmentCsv: string;
  insuranceCsv: string;
  expected: {
    patientCreated: number;
    patientWarnings: number;
    patientInvalid: number;
    patientUpdated?: number;
    patientSkipped?: number;
    appointmentCreated: number;
    appointmentWarnings: number;
    appointmentInvalid: number;
    appointmentUpdated?: number;
    appointmentSkipped?: number;
    insuranceCreated: number;
    insuranceWarnings: number;
    insuranceInvalid: number;
    insuranceUpdated?: number;
    insuranceSkipped?: number;
  };
};

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map(row => row.map(cell => escapeCsv(cell)).join(',')).join('\n');
}

function nextIso(daysAhead: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString();
}

export function buildPilotSimulationCases(): PilotSimulationCase[] {
  const apptDate = nextIso(14, 0, 0).slice(0, 10);
  const apptStart = (time: string) => `${apptDate}T${time}:00.000Z`;
  const insuranceBranch = 'Main Clinic';

  return [
    {
      clinicName: 'Harley Street Medical Group',
      slug: 'harley-street-medical',
      branchNames: ['Downtown Medical Centre', 'Northgate Wellness Studio'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-1001', 'Maya', 'Lopez', 'maya.lopez@example.com', '+1 646 555 0144', 'ACTIVE', 'Downtown Medical Centre', 'vip;follow-up'],
          ['PAT-1002', 'Jon', 'Adams', 'jon.adams@example.com', '+1 646 555 0177', 'AT_RISK', 'Northgate Wellness Studio', 'rebooking;missed-call'],
          ['PAT-1003', 'Ana', 'Patel', 'ana.patel@example.com', '+1 646 555 0199', 'NEW', 'Downtown Medical Centre', 'new-intake'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-1001', 'Annual physical', apptStart('09:00'), apptStart('09:30'), 'CONFIRMED', 'EMAIL', 'Downtown Medical Centre', 'DR-MITCHELL', 'Routine annual visit', '180'],
          ['PAT-1002', 'Blood pressure follow-up', apptStart('10:00'), apptStart('10:30'), 'ARRIVED', 'SMS', 'Northgate Wellness Studio', 'DR-OKAFOR', 'Bring home cuff logs', '120'],
          ['PAT-1003', 'Nutrition review', apptStart('11:00'), apptStart('11:30'), 'CONFIRMED', 'CALL', 'Downtown Medical Centre', 'DR-SHARMA', 'Diet review and labs', '150'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-1001', 'Blue Cross Blue Shield', 'PPO Gold', 'BCBS-1001', 'GRP-22', 'Self', 'Maya Lopez', 'verified', 'true', insuranceBranch, 'PAYER-BCBS-1'],
          ['PAT-1002', 'Aetna', 'HSA Silver', 'AET-1002', 'GRP-44', 'Self', 'Jon Adams', 'pending', 'true', insuranceBranch, 'PAYER-AETNA-2'],
          ['PAT-1003', 'UnitedHealthcare', 'Family Plus', 'UHC-1003', 'GRP-58', 'Child', 'Sam Patel', 'verified', 'true', insuranceBranch, 'PAYER-UHC-3'],
        ],
      ),
      expected: {
        patientCreated: 3,
        patientWarnings: 0,
        patientInvalid: 0,
        appointmentCreated: 3,
        appointmentWarnings: 0,
        appointmentInvalid: 0,
        insuranceCreated: 3,
        insuranceWarnings: 0,
        insuranceInvalid: 0,
      },
    },
    {
      clinicName: 'Riverbend Family Health',
      slug: 'riverbend-family-health',
      branchNames: ['Riverbend Main', 'Riverbend Pediatrics'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-2001', 'Elena', 'Garcia', 'elena.garcia@example.com', '+1 212 555 0191', 'ACTIVE', 'Riverbend Main', 're-engagement;high-value'],
          ['PAT-2002', 'Chris', 'Nguyen', 'not-an-email', '+1 212 555 0172', 'ACTIVE', 'Riverbend Main', 'email-check'],
          ['PAT-2003', 'Priya', 'Shah', 'priya.shah@example.com', '+1 212 555 0140', 'RETAINED', 'Riverbend Pediatrics', 'family-plan'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-2001', 'Follow-up visit', apptStart('09:30'), apptStart('10:00'), 'CONFIRMED', 'SMS', 'Riverbend Main', 'DR-CLARKE', 'Medication review', '130'],
          ['PAT-2002', 'New patient consult', apptStart('10:30'), apptStart('11:00'), 'WAITLIST', 'EMAIL', 'Riverbend Main', 'DR-BROOKS', 'Awaiting intake forms', '160'],
          ['PAT-2003', 'Pediatric consult', apptStart('11:30'), apptStart('12:00'), 'CONFIRMED', 'VIDEO', 'Riverbend Pediatrics', 'DR-WONG', 'Parent present', '140'],
          ['', 'Missing patient ref - should be skipped', apptStart('12:15'), apptStart('12:45'), 'RISKY', 'SMS', 'Riverbend Main', 'DR-CLARKE', 'Validation check row', '90'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-2001', 'Cigna', 'Core PPO', 'CIG-2001', 'GRP-10', 'Self', 'Elena Garcia', 'verified', 'true', 'Riverbend Main', 'PAYER-CIGNA-1'],
          ['PAT-2002', 'Cigna', 'Core PPO', 'CIG-2002', 'GRP-10', 'Self', 'Chris Nguyen', 'verified', 'maybe', 'Riverbend Main', 'PAYER-CIGNA-2'],
          ['PAT-2003', 'Oscar Health', 'Family PPO', 'OSC-2003', 'GRP-11', 'Child', 'Lin Shah', 'pending', 'true', 'Riverbend Pediatrics', 'PAYER-OSCAR-3'],
        ],
      ),
      expected: {
        patientCreated: 3,
        patientWarnings: 1,
        patientInvalid: 0,
        appointmentCreated: 3,
        appointmentWarnings: 0,
        appointmentInvalid: 1,
        insuranceCreated: 3,
        insuranceWarnings: 1,
        insuranceInvalid: 0,
      },
    },
    {
      clinicName: 'Southbank Dental House',
      slug: 'southbank-dental-house',
      branchNames: ['Southbank Dental House', 'East Wharf Orthodontics'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-3001', 'Liam', 'Owen', 'liam.owen@example.com', '+1 718 555 0133', 'ACTIVE', 'Southbank Dental House', 'cleaning;recall'],
          ['PAT-3002', 'Sofia', 'Romero', 'sofia.romero@example.com', '+1 718 555 0188', 'ACTIVE', 'East Wharf Orthodontics', 'braces-follow-up'],
          ['PAT-3003', 'Noah', 'Kim', 'noah.kim@example.com', '+1 718 555 0122', 'AT_RISK', 'Southbank Dental House', 'treatment-plan'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-3001', 'Routine cleaning', apptStart('12:00'), apptStart('12:30'), 'CONFIRMED', 'CALL', 'Southbank Dental House', 'DR-BELL', 'Recall visit', '95'],
          ['PAT-3002', 'Orthodontic adjustment', apptStart('13:00'), apptStart('13:20'), 'CONFIRMED', 'SMS', 'East Wharf Orthodontics', 'DR-AL-RASHID', 'Wire adjustment', '110'],
          ['PAT-3003', 'Crown consult', apptStart('14:00'), apptStart('14:45'), 'ARRIVED', 'EMAIL', 'Southbank Dental House', 'DR-ERIKSSON', 'Discuss options', '175'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-3001', 'Delta Dental', 'Premier PPO', 'DEL-3001', 'GRP-91', 'Self', 'Liam Owen', 'verified', 'true', 'Southbank Dental House', 'PAYER-DELTA-1'],
          ['PAT-3002', 'Delta Dental', 'Premier PPO', 'DEL-3002', 'GRP-91', 'Child', 'Marta Romero', 'verified', 'true', 'East Wharf Orthodontics', 'PAYER-DELTA-2'],
          ['PAT-3003', 'MetLife', 'Smile Plus', 'MET-3003', 'GRP-92', 'Self', 'Noah Kim', 'verified', 'true', 'Southbank Dental House', 'PAYER-METLIFE-3'],
        ],
      ),
      expected: {
        patientCreated: 3,
        patientWarnings: 0,
        patientInvalid: 0,
        appointmentCreated: 3,
        appointmentWarnings: 0,
        appointmentInvalid: 0,
        insuranceCreated: 3,
        insuranceWarnings: 0,
        insuranceInvalid: 0,
      },
    },
    {
      clinicName: 'Northpoint Behavioral Health',
      slug: 'northpoint-behavioral-health',
      branchNames: ['Northpoint Main', 'Northpoint Telehealth'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-4001', 'Nina', 'Keller', 'nina.keller@example.com', '+1 917 555 0141', 'ACTIVE', 'Northpoint Main', 'intake;therapy'],
          ['PAT-4002', 'Owen', 'Baker', 'owen.baker@example.com', '+1 917 555 0162', 'RETAINED', 'Northpoint Telehealth', 'follow-up'],
          ['', 'Tara', 'Singh', 'tara.singh@example.com', '+1 917 555 0183', 'AT_RISK', 'Northpoint Main', 'missing-ref'],
          ['PAT-4004', 'Iris', 'Cole', 'not-an-email', '+1 917 555 0194', 'ACTIVE', 'Northpoint Main', 'email-check'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-4001', 'Therapy intake', apptStart('08:30'), apptStart('09:00'), 'CONFIRMED', 'VIDEO', 'Northpoint Main', 'DR-FIELDS', 'Initial assessment', '160'],
          ['PAT-4002', 'Telehealth follow-up', apptStart('09:30'), apptStart('10:00'), 'CONFIRMED', 'VIDEO', 'Northpoint Telehealth', 'DR-LANE', 'Weekly check-in', '140'],
          ['PAT-4001', 'Care planning', apptStart('10:30'), apptStart('11:00'), 'RESCHEDULED', 'SMS', 'Northpoint Main', 'DR-FIELDS', 'Unknown status warning', '120'],
          ['', 'Missing patient ref', apptStart('11:30'), apptStart('12:00'), 'CONFIRMED', 'EMAIL', 'Northpoint Main', 'DR-FIELDS', 'Invalid row', '110'],
          ['PAT-4002', 'Bad date row', 'not-a-date', apptStart('12:30'), 'CONFIRMED', 'CALL', 'Northpoint Telehealth', 'DR-LANE', 'Date parse failure', '90'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-4001', 'Magellan', 'Behavioral Core', 'MAG-4001', 'GRP-40', 'Self', 'Nina Keller', 'verified', 'true', 'Northpoint Main', 'PAYER-MAG-1'],
          ['PAT-4002', 'Aetna', 'Behavioral Plus', 'AET-4002', 'GRP-41', 'Self', 'Owen Baker', 'pending', 'maybe', 'Northpoint Telehealth', 'PAYER-AET-2'],
          ['PAT-4002', 'Cigna', 'Behavioral Plus', 'CIG-4002', 'GRP-42', 'Self', 'Owen Baker', 'verified', 'true', 'Northpoint Telehealth', 'PAYER-CIG-2'],
          ['PAT-4001', '', '', '', '', '', '', 'verified', 'true', 'Northpoint Main', ''],
        ],
      ),
      expected: {
        patientCreated: 4,
        patientWarnings: 2,
        patientInvalid: 0,
        appointmentCreated: 3,
        appointmentWarnings: 1,
        appointmentInvalid: 2,
        insuranceCreated: 3,
        insuranceWarnings: 1,
        insuranceInvalid: 1,
      },
    },
    {
      clinicName: 'Cedar Point Multi-Specialty',
      slug: 'cedar-point-multi-specialty',
      branchNames: ['Cedar Point Central', 'Cedar Point North'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-5001', 'Alice', 'Hart', 'alice.hart@example.com', '+1 646 555 0201', 'ACTIVE', 'Cedar Point Central', 'vip;re-engage'],
          ['PAT-5002', 'Ben', 'Torres', 'ben.torres@example.com', '+1 646 555 0202', 'RETAINED', 'Cedar Point North', 'follow-up'],
          ['PAT-5001', 'Alice', 'Hart', 'alice.hart+updated@example.com', '+1 646 555 0999', 'AT_RISK', 'Cedar Point North', 'duplicate-update;branch-move'],
          ['PAT-5003', 'Cara', 'Mo', 'not-an-email', '+1 646 555 0203', 'ACTIVE', 'Cedar Point Central', 'email-check'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-5001', 'Comprehensive exam', apptStart('08:30'), apptStart('09:00'), 'CONFIRMED', 'EMAIL', 'Cedar Point Central', 'DR-ANDERSON', 'Initial consult', '190'],
          ['PAT-5002', 'Physical therapy review', apptStart('09:30'), apptStart('10:00'), 'CONFIRMED', 'SMS', 'Cedar Point North', 'DR-HAYES', 'First session', '155'],
          ['PAT-5001', 'Comprehensive exam', apptStart('08:30'), apptStart('09:00'), 'RISKY', 'EMAIL', 'Cedar Point North', 'DR-ANDERSON', 'Duplicate appointment should update', '210'],
          ['PAT-5999', 'Unmatched intake', apptStart('10:30'), apptStart('11:00'), 'CONFIRMED', 'CALL', 'Cedar Point Central', 'DR-ANDERSON', 'Should be skipped', '120'],
          ['PAT-5002', 'Recovery plan', apptStart('11:30'), apptStart('12:00'), 'RESCHEDULED', 'PUSH', 'Cedar Point North', 'DR-HAYES', 'Unknown status warning', '130'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-5001', 'Aetna', 'Core PPO', 'AET-5001', 'GRP-50', 'Self', 'Alice Hart', 'verified', 'true', 'Cedar Point Central', 'PAYER-AET-1'],
          ['PAT-5002', 'Cigna', 'Family PPO', 'CIG-5002', 'GRP-51', 'Self', 'Ben Torres', 'pending', 'true', 'Cedar Point North', 'PAYER-CIG-2'],
          ['PAT-5001', 'Aetna', 'Core PPO', 'AET-5001', 'GRP-50', 'Self', 'Alice Hart Updated', 'verified', 'true', 'Cedar Point North', 'PAYER-AET-1B'],
          ['PAT-5999', 'Blue Cross Blue Shield', 'Unmatched', 'BCBS-5999', 'GRP-59', 'Self', 'Unknown Patient', 'verified', 'true', 'Cedar Point Central', 'PAYER-BCBS-9'],
          ['PAT-5002', 'Oscar Health', 'Wellness', 'OSC-5002', 'GRP-52', 'Self', 'Ben Torres', 'verified', 'maybe', 'Cedar Point North', 'PAYER-OSC-2'],
        ],
      ),
      expected: {
        patientCreated: 3,
        patientWarnings: 1,
        patientInvalid: 0,
        patientUpdated: 1,
        patientSkipped: 0,
        appointmentCreated: 3,
        appointmentWarnings: 1,
        appointmentInvalid: 0,
        appointmentUpdated: 1,
        appointmentSkipped: 1,
        insuranceCreated: 3,
        insuranceWarnings: 1,
        insuranceInvalid: 0,
        insuranceUpdated: 1,
        insuranceSkipped: 1,
      },
    },
    {
      clinicName: 'Harborview Multi-Location Clinic',
      slug: 'harborview-multi-location-clinic',
      branchNames: ['Harborview Central', 'Harborview East'],
      patientCsv: buildCsv(
        ['external_ref', 'first_name', 'last_name', 'email', 'phone', 'lifecycle_stage', 'branch_name', 'tags'],
        [
          ['PAT-6001', 'Ava', 'Reed', 'ava.reed@example.com', '+1 646 555 0601', 'ACTIVE', 'Harborview Central', 'vip;follow-up'],
          ['PAT-6002', 'Noah', 'Bennett', 'noah.bennett@example.com', '+1 646 555 0602', 'RETAINED', 'Harborview East', 'care-plan'],
          ['PAT-6001', 'Ava', 'Reed', 'ava.reed+updated@example.com', '+1 646 555 0998', 'AT_RISK', ' harborview east ', 'duplicate-update;branch-move'],
          ['PAT-6003', 'Mia', 'Chen', 'mia.chen@example.com', '+1 646 555 0603', 'RETURNING', 'Harborview Central', 'invalid-stage'],
        ],
      ),
      appointmentCsv: buildCsv(
        ['patient_external_ref', 'service', 'starts_at', 'ends_at', 'status', 'channel', 'branch_name', 'provider_ref', 'notes', 'value'],
        [
          ['PAT-6001', 'Comprehensive exam', apptStart('08:15'), apptStart('08:45'), 'CONFIRMED', 'EMAIL', 'Harborview Central', 'DR-HUGHES', 'Initial workup', '195'],
          ['PAT-6002', 'Care coordination', apptStart('09:15'), apptStart('09:45'), 'CONFIRMED', 'SMS', 'harborview east ', 'DR-LIU', 'Multi-location routing', 'not-a-number'],
          ['PAT-6001', 'Comprehensive exam', apptStart('08:15'), apptStart('08:45'), 'RESCHEDULED', 'PUSH', 'Harborview East', 'DR-HUGHES', 'Duplicate appointment should update', '205.5'],
          ['PAT-6099', 'Unmatched follow-up', apptStart('10:15'), apptStart('10:45'), 'CONFIRMED', 'CALL', 'Harborview Central', 'DR-HUGHES', 'Should be skipped', '130'],
        ],
      ),
      insuranceCsv: buildCsv(
        ['patient_external_ref', 'payer_name', 'plan_name', 'member_id', 'group_number', 'relationship', 'subscriber_name', 'verification_status', 'active', 'branch_name', 'payer_reference'],
        [
          ['PAT-6001', 'Aetna', 'Core PPO', 'AET-6001', 'GRP-60', 'Self', 'Ava Reed', 'verified', 'true', 'Harborview Central', 'PAYER-AET-6'],
          ['PAT-6002', 'Cigna', 'Family PPO', 'CIG-6002', 'GRP-61', 'Self', 'Noah Bennett', 'pending', 'maybe', 'harborview east ', 'PAYER-CIG-6'],
          ['PAT-6001', 'Aetna', 'Core PPO', 'AET-6001', 'GRP-60', 'Self', 'Ava Reed Updated', 'verified', 'true', 'Harborview East', 'PAYER-AET-6B'],
          ['PAT-6099', 'Blue Cross Blue Shield', 'Unmatched', 'BCBS-6099', 'GRP-69', 'Self', 'Unknown Patient', 'verified', 'true', 'Harborview Central', 'PAYER-BCBS-6'],
        ],
      ),
      expected: {
        patientCreated: 3,
        patientWarnings: 1,
        patientInvalid: 0,
        patientUpdated: 1,
        patientSkipped: 0,
        appointmentCreated: 2,
        appointmentWarnings: 2,
        appointmentInvalid: 0,
        appointmentUpdated: 1,
        appointmentSkipped: 1,
        insuranceCreated: 2,
        insuranceWarnings: 1,
        insuranceInvalid: 0,
        insuranceUpdated: 1,
        insuranceSkipped: 1,
      },
    },
  ];
}
