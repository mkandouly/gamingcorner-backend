import { query } from "./db.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";

export async function initializeDatabase() {
  const createSubscribersTable = `
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createCategoriesTable = `
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createSubcategoriesTable = `
    CREATE TABLE IF NOT EXISTS subcategories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      parent_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      is_featured BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const alterCategoriesAddIsHot = `
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_hot BOOLEAN DEFAULT FALSE;
  `;

  // A brand should be creatable before its logo is ready, not blocked on it.
  const alterBrandsLogoNullable = `
    ALTER TABLE brands ALTER COLUMN logo_url DROP NOT NULL;
  `;

  // Drop the old status-transition design (IN marked a row "in_stock" by
  // serial number, then OUT flipped it to "sold") in favor of two separate
  // logs, matching how the store actually works: receiving stock doesn't
  // involve a serial number at all (just how many units, at what cost), and
  // a serial number only gets recorded at the moment a specific unit sells.
  // This is a one-time schema rebuild, not an ALTER — guarded so it only
  // fires if the table is still in the old shape (i.e. missing
  // warranty_months), so it never re-runs and wipes data on later restarts.
  const dropOldProductSerialsTableIfLegacy = `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'product_serials')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'product_serials' AND column_name = 'warranty_months'
         )
      THEN
        DROP TABLE product_serials;
      END IF;
    END $$;
  `;

  // Stock received ("IN"): a batch/shipment log, not per-unit. sku has no
  // FK to products — the store may receive stock for something not yet
  // listed on the site, so a free-typed SKU must always be accepted.
  // product_id is an optional convenience link when the item IS listed.
  const createStockReceiptsTable = `
    CREATE TABLE IF NOT EXISTS stock_receipts (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      sku VARCHAR(255) NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0),
      cost_price NUMERIC(10, 2) NOT NULL,
      source VARCHAR(255),
      notes TEXT,
      received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  const alterStockReceiptsAddSource = `
    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS source VARCHAR(255);
  `;
  const createStockReceiptsSkuIndex = `
    CREATE INDEX IF NOT EXISTS idx_stock_receipts_sku ON stock_receipts(sku);
  `;
  const createStockReceiptsSourceIndex = `
    CREATE INDEX IF NOT EXISTS idx_stock_receipts_source ON stock_receipts(source);
  `;

  // A "PC Offer" bundles several items (a build + peripherals) into one
  // sale at one combined price, rather than pricing each component
  // separately. The header (total price, shared warranty, order link)
  // lives here; the individual items it's made of live in product_serials
  // with their offer_id set and their own sale_price left null, since
  // price is only tracked at the bundle level.
  const createPcOffersTable = `
    CREATE TABLE IF NOT EXISTS pc_offers (
      id SERIAL PRIMARY KEY,
      sale_price NUMERIC(10, 2) NOT NULL,
      warranty_months INT,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      notes TEXT,
      sold_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Sold units ("OUT"): one row per physical unit actually sold, created
  // at the moment of sale — this is where the serial number first gets
  // captured, along with warranty length and sale price, for later
  // warranty lookups. Same no-FK-on-sku reasoning as stock_receipts.
  // serial_number is globally unique (normalized to uppercase on write) so
  // staff can look one up without knowing which SKU it belongs to.
  //
  // offer_id links a row to a PC Offer bundle when it's one component of a
  // combined sale — in that case serial_number may be left blank (not every
  // peripheral has one) and sale_price is null (the price lives on the
  // pc_offers header instead). For a normal single-item sale, offer_id is
  // null and the app layer requires both serial_number and sale_price.
  const createProductSerialsTable = `
    CREATE TABLE IF NOT EXISTS product_serials (
      id SERIAL PRIMARY KEY,
      offer_id INT REFERENCES pc_offers(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      sku VARCHAR(255) NOT NULL,
      serial_number VARCHAR(255) UNIQUE,
      warranty_months INT,
      sale_price NUMERIC(10, 2),
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      notes TEXT,
      sold_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  // Upgrade path for a database where this table already exists from the
  // previous design (serial_number/sale_price NOT NULL, no offer_id).
  const alterProductSerialsForOffers = `
    ALTER TABLE product_serials ADD COLUMN IF NOT EXISTS offer_id INT REFERENCES pc_offers(id) ON DELETE CASCADE;
    ALTER TABLE product_serials ALTER COLUMN serial_number DROP NOT NULL;
    ALTER TABLE product_serials ALTER COLUMN sale_price DROP NOT NULL;
  `;
  const createSerialsOfferIndex = `
    CREATE INDEX IF NOT EXISTS idx_product_serials_offer_id ON product_serials(offer_id);
  `;
  const createSerialsSkuIndex = `
    CREATE INDEX IF NOT EXISTS idx_product_serials_sku ON product_serials(sku);
  `;

  const createBrandsTable = `
    CREATE TABLE IF NOT EXISTS brands (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      logo_url TEXT NOT NULL,
      is_featured BOOLEAN NOT NULL DEFAULT false,
      is_popular BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Distributor profiles — registered separately from regular customers so
  // a sale can be marked as going to a distributor instead of a client.
  // No PC Offers for distributors (they don't buy built PCs), so this has
  // no relationship to pc_offers at all, only to product_serials below.
  const createDistributorsTable = `
    CREATE TABLE IF NOT EXISTS distributors (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255),
      phone VARCHAR(50),
      email VARCHAR(255),
      address TEXT,
      notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // A sale with distributor_id set is a distributor sale; left null (the
  // default for every existing row) it's a regular client sale — no
  // backfill needed, old data is automatically "client" by having nothing
  // in this new column.
  const alterProductSerialsAddDistributor = `
    ALTER TABLE product_serials ADD COLUMN IF NOT EXISTS distributor_id INT REFERENCES distributors(id) ON DELETE SET NULL;
  `;
  const createSerialsDistributorIndex = `
    CREATE INDEX IF NOT EXISTS idx_product_serials_distributor_id ON product_serials(distributor_id);
  `;

  // Add to createProductsTable in dbInit.js:
  const createProductsTable = `
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL,
    sale_price NUMERIC(10, 2),
    brand_id INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    image_url TEXT,
    images JSONB DEFAULT '[]'::jsonb,
    category_slug VARCHAR(100) REFERENCES subcategories(slug) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
`;

  // Upgrade path: this table may have been created by an earlier version
  // of this schema that didn't yet have every column the current admin
  // routes read/write. ADD COLUMN IF NOT EXISTS is a safe no-op wherever
  // the column already exists correctly.
  const alterProductsAddDescription = `
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
  `;
  const alterProductsAddImageUrl = `
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
  `;
  const alterProductsAddImages = `
    ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb;
  `;
  const alterProductsAddOutOfStock = `
    ALTER TABLE products ADD COLUMN IF NOT EXISTS out_of_stock BOOLEAN NOT NULL DEFAULT FALSE;
  `;

  // Upgrade path: on some existing databases, products.images may have
  // been created as a native Postgres array type (e.g. TEXT[]) rather than
  // jsonb. Writing JSON-bracket syntax ('["a","b"]') to a native array
  // column fails with "malformed array literal", since Postgres expects
  // '{a,b}' syntax for those. This coerces the column to jsonb if it isn't
  // already, preserving existing data via to_jsonb().
  const fixProductsImagesColumnType = `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'images' AND data_type <> 'jsonb'
      ) THEN
        ALTER TABLE products ALTER COLUMN images DROP DEFAULT;
        ALTER TABLE products ALTER COLUMN images TYPE JSONB USING to_jsonb(images);
        ALTER TABLE products ALTER COLUMN images SET DEFAULT '[]'::jsonb;
      END IF;
    END $$;
  `;

  const createProductSpecificationsTable = `
    CREATE TABLE IF NOT EXISTS product_specifications (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      specification VARCHAR(255) NOT NULL,
      details TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createSpecsProductIndex = `
    CREATE INDEX IF NOT EXISTS idx_product_specs_product_id 
    ON product_specifications(product_id);
  `;

  const createAdminsTable = `
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'admin' CHECK (role IN ('root', 'admin')),
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_seed BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      last_login TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Upgrade path for a database that already has an `admins` table from
  // before permissions/is_seed existed — CREATE TABLE IF NOT EXISTS above
  // is a no-op on an existing table, so new columns need adding explicitly.
  const alterAdminsAddPermissions = `
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
  `;
  const alterAdminsAddIsSeed = `
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE;
  `;

  const createBannersTable = `
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      image_url TEXT NOT NULL,
      link TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Orders placed at checkout. delivery_price starts NULL — the store sets
  // it later (see PATCH /api/admin/orders/:id/delivery-price). subtotal is
  // the sum of order_items line totals, snapshotted at order time so price
  // changes to a product afterward don't retroactively change past orders.
  const createOrdersTable = `
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone_country_code VARCHAR(10) NOT NULL DEFAULT '+961',
      phone_number VARCHAR(30) NOT NULL,
      governorate VARCHAR(100) NOT NULL,
      city VARCHAR(100) NOT NULL,
      area VARCHAR(100) NOT NULL,
      address_line TEXT NOT NULL,
      email VARCHAR(255),
      subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0,
      delivery_price NUMERIC(10, 2),
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_preparation', 'out_for_delivery', 'delivered', 'cancelled')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Line items are snapshotted (name/sku/price copied in) so an order still
  // reads correctly even if the product is later edited or deleted.
  const createOrderItemsTable = `
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      product_name VARCHAR(255) NOT NULL,
      product_sku VARCHAR(255),
      unit_price NUMERIC(10, 2) NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0),
      line_total NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createOrderItemsOrderIndex = `
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
  `;

  const createOrdersStatusIndex = `
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `;

  // Generic key/value store for small pieces of site content the admin
  // panel edits directly — starting with the top announcement bar text, but
  // built to hold more settings later without new migrations each time.
  const createSiteSettingsTable = `
    CREATE TABLE IF NOT EXISTS site_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const seedAnnouncementBarSetting = `
    INSERT INTO site_settings (key, value)
    VALUES ('announcement_bar', 'Free Express Shipping on Orders Over $150 | Local Warranty Included')
    ON CONFLICT (key) DO NOTHING;
  `;

  try {
    console.log("Initializing database schema...");

    // Independent tables
    await query(createSubscribersTable);
    await query(createCategoriesTable);
    await query(alterCategoriesAddIsHot);
    await query(createBrandsTable);
    await query(createDistributorsTable);
    await query(alterBrandsLogoNullable);
    await query(createAdminsTable);
    await query(alterAdminsAddPermissions);
    await query(alterAdminsAddIsSeed);
    await query(createBannersTable);
    await query(createSiteSettingsTable);

    // Foreign key dependent tables
    await query(createSubcategoriesTable);
    await query(createProductsTable);
    await query(alterProductsAddDescription);
    await query(alterProductsAddImageUrl);
    await query(alterProductsAddImages);
    await query(alterProductsAddOutOfStock);
    await query(fixProductsImagesColumnType);

    // Product Specifications table & Index
    await query(createProductSpecificationsTable);
    await query(createSpecsProductIndex);

    // Orders (depend on products for order_items.product_id)
    await query(createOrdersTable);
    await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
    await query(createOrderItemsTable);
    await query(createOrderItemsOrderIndex);
    await query(createOrdersStatusIndex);

    // Product serial numbers (depend on products.sku and orders.id) — drop
    // the old status-transition design first, then create the current logs.
    await query(dropOldProductSerialsTableIfLegacy);
    await query(createStockReceiptsTable);
    await query(alterStockReceiptsAddSource);
    await query(createStockReceiptsSkuIndex);
    await query(createStockReceiptsSourceIndex);
    await query(createPcOffersTable);
    await query(createProductSerialsTable);
    await query(alterProductSerialsForOffers);
    await query(alterProductSerialsAddDistributor);
    await query(createSerialsDistributorIndex);
    await query(createSerialsSkuIndex);
    await query(createSerialsOfferIndex);

    // Seed default settings (no-op if already set by the admin)
    await query(seedAnnouncementBarSetting);

    // Seed a root admin account if none exists yet (first run only)
    await seedRootAdminIfNeeded();

    console.log("Database tables verified/created successfully.");
  } catch (error) {
    console.error("Failed to initialize database schema:", error);
    throw error;
  }
}

// Generates a random, URL-safe-ish password for the one-time seeded root
// account. Only used when no ROOT_ADMIN_PASSWORD env var is supplied.
function generateRandomPassword(length = 16) {
  return crypto
    .randomBytes(length)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, length);
}

// Creates a root admin account on first run if the admins table has no
// root account at all yet. This seeded account is flagged is_seed = true
// so it can be identified and automatically removed later, the moment the
// user creates their own root account through the admin panel (see
// adminAccountsRoutes.js) — it exists only to get you logged in the first
// time.
async function seedRootAdminIfNeeded() {
  const { rows } = await query(`SELECT COUNT(*)::int AS count FROM admins WHERE role = 'root'`);
  if (rows[0].count > 0) return;

  const email = process.env.ROOT_ADMIN_EMAIL || "root@gamingcorner.local";
  const password = process.env.ROOT_ADMIN_PASSWORD || generateRandomPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  await query(
    `INSERT INTO admins (name, email, password_hash, role, permissions, is_seed, is_active)
     VALUES ($1, $2, $3, 'root', '{}'::jsonb, TRUE, TRUE)
     ON CONFLICT (email) DO NOTHING`,
    ["Root Admin", email, passwordHash]
  );

  console.log("\n==================================================");
  console.log(" Seeded a one-time ROOT admin account (first run)");
  console.log(` Email:    ${email}`);
  console.log(` Password: ${password}`);
  console.log(" Log in and create your own root account right away —");
  console.log(" this seeded account is deleted automatically the");
  console.log(" moment a new root account is created.");
  console.log("==================================================\n");
}
