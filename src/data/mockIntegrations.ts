import type { Integration } from '../types';

export const integrations: Integration[] = [
  { id: 'i1', name: 'WhatsApp Business', category: 'Messaging', status: 'connected', icon: 'MessagesSquare', description: 'Two-way patient messaging, appointment confirmations and reactivation nudges.', lastSync: '5 min ago' },
  { id: 'i2', name: 'SMS Gateway', category: 'Messaging', status: 'connected', icon: 'MessageCircle', description: 'Transactional reminders, no-show recovery and campaign delivery.', lastSync: '2 min ago' },
  { id: 'i3', name: 'Email Provider', category: 'Marketing', status: 'connected', icon: 'Mail', description: 'Newsletter, follow-up sequences and campaign workflows.', lastSync: '12 min ago' },
  { id: 'i4', name: 'Google Business Profile', category: 'Reputation', status: 'connected', icon: 'Globe2', description: 'Review monitoring, ratings trends and local listing performance.', lastSync: '3 min ago' },
  { id: 'i5', name: 'Stripe Payments', category: 'Payments', status: 'connected', icon: 'CreditCard', description: 'Secure payment capture, package billing and membership charges.', lastSync: '1 hour ago' },
  { id: 'i6', name: 'QuickBooks', category: 'Accounting', status: 'disconnected', icon: 'BookOpen', description: 'Financial sync for revenue, invoices and accounting reconciliation.' },
  { id: 'i7', name: 'Call Tracking', category: 'Telephony', status: 'connected', icon: 'Phone', description: 'Missed call detection and AI recovery workflows.', lastSync: 'Just now' },
  { id: 'i8', name: 'Website Booking Widget', category: 'Booking', status: 'connected', icon: 'Monitor', description: 'Self-booking widget embedded on practice websites.', lastSync: '4 min ago' },
];
