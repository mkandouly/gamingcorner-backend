import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import adminRoutes from "./src/routes/adminRoutes.js";
import { initializeDatabase } from "./initDb.js";
import latestProductsRoute from "./src/routes/latestProducts.js";
import categoryProductsRoute from "./src/routes/categoryProducts.js";
import featuredSubcategoriesRoute from "./src/routes/featuredSubcategories.js";
import brandIsPopularRoute from "./src/routes/brandIsPopular.js";
import featuredBrandsRoute from "./src/routes/featuredBrands.js";
import brandProductsRoute from "./src/routes/brandProducts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

initializeDatabase();

app.use(cors());
app.use(express.json());

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Admin routes
app.use('/api/admin', adminRoutes);

app.use('/api/latestproducts', latestProductsRoute);

app.use('/api/category', categoryProductsRoute);

app.use('/api/subcategory', featuredSubcategoriesRoute);

app.use('/api/popularbrands', brandIsPopularRoute);

app.use('/api/brands', featuredBrandsRoute);

app.use('/api/brand', brandProductsRoute);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});