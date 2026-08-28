import type { InventoryItem } from '../types';

export const inventoryItems: InventoryItem[] = [
  { id: 'i1', name: 'Botox (Allergan)', category: 'Aesthetics', branchId: 'b1', currentStock: 3, unit: 'vials', reorderLevel: 5, expiryDate: '2025-09-15', unitCost: 280, usagePerWeek: 4, status: 'low', supplier: 'Allergan UK' },
  { id: 'i2', name: 'Composite Resin', category: 'Dental', branchId: 'b3', currentStock: 8, unit: 'syringes', reorderLevel: 10, expiryDate: '2025-06-15', unitCost: 42, usagePerWeek: 3, status: 'expiring', supplier: 'Dentsply Sirona' },
  { id: 'i3', name: 'Dental Bonding Agent', category: 'Dental', branchId: 'b3', currentStock: 4, unit: 'bottles', reorderLevel: 5, expiryDate: '2025-06-18', unitCost: 35, usagePerWeek: 2, status: 'expiring', supplier: 'Kerr Dental' },
  { id: 'i4', name: 'Hyaluronic Acid Filler', category: 'Aesthetics', branchId: 'b1', currentStock: 12, unit: 'syringes', reorderLevel: 8, unitCost: 180, usagePerWeek: 5, status: 'ok', supplier: 'Galderma' },
  { id: 'i5', name: 'Rapid Blood Glucose Test Strips', category: 'Diagnostics', branchId: 'b4', currentStock: 2, unit: 'boxes', reorderLevel: 4, expiryDate: '2025-08-01', unitCost: 28, usagePerWeek: 1, status: 'critical', supplier: 'Roche Diagnostics' },
  { id: 'i6', name: 'Physiotherapy TENS Pads', category: 'Physiotherapy', branchId: 'b2', currentStock: 24, unit: 'pairs', reorderLevel: 10, unitCost: 8, usagePerWeek: 6, status: 'ok', supplier: 'PhysioSupplies Ltd' },
  { id: 'i7', name: 'Disposable Gloves (Nitrile)', category: 'General', branchId: 'b1', currentStock: 14, unit: 'boxes', reorderLevel: 10, unitCost: 12, usagePerWeek: 3, status: 'ok', supplier: 'MedSource Direct' },
  { id: 'i8', name: 'Blood Pressure Cuffs', category: 'Diagnostics', branchId: 'b4', currentStock: 2, unit: 'units', reorderLevel: 3, unitCost: 65, usagePerWeek: 1, status: 'low', supplier: 'Omron Healthcare' },
  { id: 'i9', name: 'Salicylic Acid Peel Solution', category: 'Dermatology', branchId: 'b3', currentStock: 6, unit: 'bottles', reorderLevel: 4, expiryDate: '2025-11-20', unitCost: 95, usagePerWeek: 2, status: 'ok', supplier: 'Mesoestetic' },
  { id: 'i10', name: 'Lab Sample Collection Kits', category: 'Diagnostics', branchId: 'b1', currentStock: 3, unit: 'kits', reorderLevel: 6, unitCost: 22, usagePerWeek: 2, status: 'low', supplier: 'BD Medical' },
];
