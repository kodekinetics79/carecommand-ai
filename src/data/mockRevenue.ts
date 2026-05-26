import type { RevenueData } from '../types';

export const revenueData: RevenueData[] = [
  { month: 'Dec 24', revenue: 265000, recovered: 14200, lost: 38000, campaigns: 5800 },
  { month: 'Jan 25', revenue: 248000, recovered: 16800, lost: 41000, campaigns: 7200 },
  { month: 'Feb 25', revenue: 271000, recovered: 19400, lost: 35500, campaigns: 9100 },
  { month: 'Mar 25', revenue: 289000, recovered: 21600, lost: 32000, campaigns: 11400 },
  { month: 'Apr 25', revenue: 302000, recovered: 24800, lost: 29000, campaigns: 14200 },
  { month: 'May 25', revenue: 318000, recovered: 27200, lost: 26500, campaigns: 16800 },
];

export const branchRevenue = [
  { name: 'Downtown', revenue: 124500, target: 130000, lastMonth: 118000 },
  { name: 'Westside', revenue: 78200, target: 100000, lastMonth: 82000 },
  { name: 'Northgate', revenue: 96800, target: 95000, lastMonth: 91000 },
  { name: 'Southbank', revenue: 41300, target: 65000, lastMonth: 38000 },
];

export const serviceRevenue = [
  { service: 'Dermatology & Aesthetics', revenue: 142000, percent: 44.7 },
  { service: 'Dental', revenue: 87600, percent: 27.5 },
  { service: 'Family Medicine', revenue: 48200, percent: 15.2 },
  { service: 'Physiotherapy', revenue: 24800, percent: 7.8 },
  { service: 'Wellness & Nutrition', revenue: 15200, percent: 4.8 },
];
