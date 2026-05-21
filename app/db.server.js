import { PrismaClient } from "@prisma/client";

const prisma = global.prismaGlobal || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

export default prisma;
