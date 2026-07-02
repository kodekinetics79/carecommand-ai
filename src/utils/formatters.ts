import { getCurrency, getCurrencyLocale } from '../lib/preferences';

export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat(getCurrencyLocale(), {
    style: 'currency',
    currency: getCurrency(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

// Compact form ($12K / $1.2M) for axis ticks and dense chart chrome.
export const formatCurrencyCompact = (value: number): string => {
  return new Intl.NumberFormat(getCurrencyLocale(), {
    style: 'currency',
    currency: getCurrency(),
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
};

export const formatNumber = (value: number): string => {
  return new Intl.NumberFormat('en-US').format(value);
};

export const formatPercent = (value: number, decimals = 1): string => {
  return `${value.toFixed(decimals)}%`;
};

export const formatDate = (isoDate: string): string => {
  return new Date(isoDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

export const formatRelativeDate = (isoDate: string): string => {
  const now = new Date();
  const date = new Date(isoDate);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
};

export const getRiskColor = (risk: number): string => {
  if (risk >= 70) return 'text-red-600';
  if (risk >= 40) return 'text-amber-600';
  return 'text-emerald-600';
};

export const getRiskBg = (risk: number): string => {
  if (risk >= 70) return 'bg-red-50 text-red-700';
  if (risk >= 40) return 'bg-amber-50 text-amber-700';
  return 'bg-emerald-50 text-emerald-700';
};

export const getScoreColor = (score: number): string => {
  if (score >= 70) return 'text-emerald-600';
  if (score >= 40) return 'text-amber-600';
  return 'text-red-600';
};

export const getSeverityBg = (severity: string): string => {
  if (severity === 'high') return 'bg-red-50 border-red-200';
  if (severity === 'medium') return 'bg-amber-50 border-amber-200';
  return 'bg-blue-50 border-blue-200';
};

export const getSeverityDot = (severity: string): string => {
  if (severity === 'high') return 'bg-red-500';
  if (severity === 'medium') return 'bg-amber-500';
  return 'bg-blue-500';
};
