import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import adminRoutes from "./src/routes/adminRoutes.js";
import authRoutes from "./src/routes/authRoutes.js";
import adminAccountsRoutes from "./src/routes/adminAccountsRoutes.js";
import { initializeDatabase } from "./initDb.js";
import latestProductsRoute from "./src/routes/latestProducts.js";
import categoryProductsRoute from "./src/routes/categoryProducts.js";
import featuredSubcategoriesRoute from "./src/routes/featuredSubcategories.js";
import brandIsPopularRoute from "./src/routes/brandIsPopular.js";
import featuredBrandsRoute from "./src/routes/featuredBrands.js";
import brandProductsRoute from "./src/routes/brandProducts.js";
import productsRoute from "./src/routes/productsRoutes.js";
import ordersRoutes from "./src/routes/ordersRoutes.js";
import settingsRoutes from "./src/routes/settingsRoutes.js";
import bannersPublicRoutes from "./src/routes/bannersPublicRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

initializeDatabase();

app.use(cors());
app.use(express.json());
// In your Express backend app entry file
app.disable('etag');

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Auth and admin-account-management routes must be mounted BEFORE the
// broader /api/admin mount below: adminRoutes applies requireAuth to every
// path under it with no exceptions, so if it were mounted first it would
// intercept /api/admin/auth/login too and make logging in impossible.
app.use('/api/admin/auth', authRoutes);
app.use('/api/admin/accounts', adminAccountsRoutes);

// Admin routes
app.use('/api/admin', adminRoutes);

app.use('/api/latestproducts', latestProductsRoute);

app.use('/api/category', categoryProductsRoute);

app.use('/api/subcategory', featuredSubcategoriesRoute);

app.use('/api/popularbrands', brandIsPopularRoute);

app.use('/api/brands', featuredBrandsRoute);

app.use('/api/brand', brandProductsRoute);

app.use('/api/products', productsRoute);

app.use('/api/orders', ordersRoutes);

app.use('/api/settings', settingsRoutes);

app.use('/api/banners', bannersPublicRoutes);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});