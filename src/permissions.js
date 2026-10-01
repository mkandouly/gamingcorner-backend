// src/permissions.js
//
// Every permission a non-root admin account can be granted, grouped by
// resource. This is the single source of truth on the backend: the
// admin-accounts route serves this list so the frontend can render
// checkboxes without hardcoding them twice, and the auth middleware
// validates against it so an unknown key can never sneak into an account's
// permissions object.
//
// Root accounts (role = 'root') implicitly have every permission and are
// never checked against this object — see middleware/auth.js.
export const PERMISSION_GROUPS = [
  {
    key: 'products',
    label: 'Products',
    permissions: [
      { key: 'products.view', label: 'View products' },
      { key: 'products.create', label: 'Create products' },
      { key: 'products.edit', label: 'Edit products' },
      { key: 'products.delete', label: 'Delete products' },
    ],
  },
  {
    key: 'categories',
    label: 'Categories',
    permissions: [
      { key: 'categories.view', label: 'View categories' },
      { key: 'categories.create', label: 'Create categories' },
      { key: 'categories.edit', label: 'Edit categories' },
      { key: 'categories.delete', label: 'Delete categories' },
    ],
  },
  {
    key: 'subcategories',
    label: 'Subcategories',
    permissions: [
      { key: 'subcategories.view', label: 'View subcategories' },
      { key: 'subcategories.create', label: 'Create subcategories' },
      { key: 'subcategories.edit', label: 'Edit subcategories' },
      { key: 'subcategories.delete', label: 'Delete subcategories' },
    ],
  },
  {
    key: 'brands',
    label: 'Brands',
    permissions: [
      { key: 'brands.view', label: 'View brands' },
      { key: 'brands.create', label: 'Create brands' },
      { key: 'brands.edit', label: 'Edit brands' },
      { key: 'brands.delete', label: 'Delete brands' },
    ],
  },
  {
    key: 'banners',
    label: 'Banners',
    permissions: [
      { key: 'banners.view', label: 'View banners' },
      { key: 'banners.create', label: 'Create banners' },
      { key: 'banners.edit', label: 'Edit banners' },
      { key: 'banners.delete', label: 'Delete banners' },
    ],
  },
  {
    key: 'orders',
    label: 'Orders',
    permissions: [
      { key: 'orders.view', label: 'View orders' },
      { key: 'orders.update_status', label: 'Update order status (incl. cancel)' },
      { key: 'orders.set_delivery_price', label: 'Set delivery price' },
    ],
  },
  {
    key: 'settings',
    label: 'Site Settings',
    permissions: [
      { key: 'settings.view', label: 'View site settings' },
      { key: 'settings.edit', label: 'Edit site settings (e.g. announcement bar)' },
    ],
  },
  {
    key: 'subscribers',
    label: 'Newsletter Subscribers',
    permissions: [{ key: 'subscribers.view', label: 'View subscribers' }],
  },
  {
    key: 'serials',
    label: 'Serial Numbers / Warranty',
    permissions: [
      { key: 'serials.view', label: 'View serial numbers / look up warranty status' },
      { key: 'serials.create', label: 'Mark a serial number as received (IN)' },
      { key: 'serials.edit', label: 'Mark a serial number as sold (OUT) / edit notes' },
      { key: 'serials.delete', label: 'Delete a serial number record' },
    ],
  },
  {
    key: 'media',
    label: 'Media',
    permissions: [{ key: 'media.upload', label: 'Upload images' }],
  },
  {
    key: 'distributors',
    label: 'Distributor Profiles',
    permissions: [
      { key: 'distributors.view', label: 'View distributors' },
      { key: 'distributors.create', label: 'Register distributors' },
      { key: 'distributors.edit', label: 'Edit distributors' },
      { key: 'distributors.delete', label: 'Delete distributors' },
    ],
  },
  {
    key: 'serials',
    label: 'Inventory & Warranty',
    permissions: [
      { key: 'serials.view', label: 'View stock receipts and sold-unit/warranty records' },
      { key: 'serials.manage', label: 'Log stock received in, record sales with serial numbers' },
    ],
  },
];

// Flat set of every valid permission key, used to validate/strip unknown
// keys when an account's permissions are created or updated.
export const ALL_PERMISSION_KEYS = new Set(
  PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key))
);

// Keeps only recognized keys, coerced to booleans. Anything not in
// ALL_PERMISSION_KEYS is silently dropped — an admin account's permissions
// object can never contain a key the backend doesn't itself enforce.
export function sanitizePermissions(input) {
  const clean = {};
  if (!input || typeof input !== 'object') return clean;

  for (const key of ALL_PERMISSION_KEYS) {
    if (input[key] === true) clean[key] = true;
  }
  return clean;
}
