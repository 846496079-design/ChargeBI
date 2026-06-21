import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/query/orchestrator";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const response = await answerQuestion(String(body.question || ""), body.context || {});
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        type: "error",
        message: error instanceof Error ? error.message : "查询失败"
      },
      { status: 500 }
    );
  }
}
