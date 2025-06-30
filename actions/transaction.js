"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);
  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }
  return date;
}

// ✅ Server Action version of createTransaction
export async function createTransaction(formData) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const req = await request();
    const decision = await aj.protect(req, { userId, requested: 1 });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked by protection layer");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const rawAmount = formData.amount;
    const rawDate = formData.date;

    const data = {
      amount: parseFloat(rawAmount),
      description: formData.description,
      accountId: formData.accountId,
      type: formData.type,
      categoryId: formData.categoryId,
      category: formData.category, // Ensure category is included
      date: new Date(rawDate),
      isRecurring: formData.isRecurring === "true",
      recurringInterval: formData.recurringInterval,
    };

    const account = await db.account.findUnique({
      where: { id: data.accountId, userId: user.id },
    });
    if (!account) throw new Error("Account not found");

    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;
    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
      return { success: false, error: "Too many requests. Please try again later." };
      }
      return { success: false, error: "Request blocked by protection layer" };
    }
    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...data,
          amount: new Prisma.Decimal(data.amount),
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: new Prisma.Decimal(newBalance),
        },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ✅ Other methods remain unchanged...

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const originalTransaction = await db.transaction.findUnique({
      where: { id, userId: user.id },
      include: { account: true },
    });
    if (!originalTransaction) throw new Error("Transaction not found");

    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: { id, userId: user.id },
        data: {
          ...data,
          amount: new Prisma.Decimal(data.amount),
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: new Prisma.Decimal(netBalanceChange),
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getTransaction(id) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const transaction = await db.transaction.findUnique({
      where: { id, userId: user.id },
    });
    if (!transaction) throw new Error("Transaction not found");

    return serializeAmount(transaction);
  } catch (error) {
    throw new Error(error.message || "Failed to fetch transaction");
  }
}

export async function getUserTransactions(query = {}) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const transactions = await db.transaction.findMany({
      where: { userId: user.id, ...query },
      include: { account: true },
      orderBy: { date: "desc" },
    });

    return {
      success: true,
      data: transactions.map(serializeAmount),
    };
  } catch (error) {
    // If the error message is "Too many requests. Please try again later.", treat as error
    return { success: false, error: error.message };
  }
}

export async function scanReceipt(file) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const arrayBuffer = await file.arrayBuffer();
    const base64String = Buffer.from(arrayBuffer).toString("base64");

    const prompt = `
      Analyze this receipt image and extract the following information in JSON format:
      {
        "amount": number,
        "date": "ISO date string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }
      If not a receipt, return an empty object.
    `;

    const result = await model.generateContent([
      {
        inlineData: { data: base64String, mimeType: file.type },
      },
      prompt,
    ]);

    const response = await result.response;
    const cleaned = response.text().replace(/```(?:json)?\n?/g, "").trim();

    try {
      const data = JSON.parse(cleaned);
      return {
        amount: parseFloat(data.amount),
        date: new Date(data.date),
        description: data.description,
        category: data.category,
        merchantName: data.merchantName,
      };
    } catch (err) {
      console.error("Parse error:", err);
      throw new Error("Invalid response format from Gemini");
    }
  } catch (error) {
    console.error("Scan error:", error);
    throw new Error("Failed to scan receipt");
  }
}