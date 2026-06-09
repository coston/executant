import { Request, Response } from "express";
import { db } from "./db";

export async function searchUsers(req: Request, res: Response): Promise<void> {
  const { name, limit } = req.query;

  if (!name) {
    res.status(400).json({ error: "name query param required" });
    return;
  }

  const safeLimit = Math.min(Number(limit) || 10, 100);

  const rows = await db.query(
    `SELECT id, name, email FROM users WHERE name LIKE '%${name}%' LIMIT ${safeLimit}`,
  );

  res.json({ users: rows });
}
