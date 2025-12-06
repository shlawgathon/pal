// Prisma configuration for PAL with MongoDB
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Use env var or placeholder for generation-only mode
    url: process.env.MONGODB_URI || "mongodb://localhost:27017/pal",
  },
});
