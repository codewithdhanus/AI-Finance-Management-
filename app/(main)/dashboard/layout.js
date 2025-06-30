import arcjet, { createMiddleware, detectBot, shield } from "@arcjet/next";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// ✅ Routes that require authentication
const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/account(.*)",
  "/transaction(.*)",
]);

// ✅ ArcJet Middleware (runs first)
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    detectBot({
      mode: "LIVE",
      allow: [
        "CATEGORY:SEARCH_ENGINE",
        "GO_HTTP",
      ],
    }),
  ],
});

// ✅ Clerk Middleware (runs after ArcJet)
const clerk = clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();

  // ✅ Redirect unauthenticated users trying to access protected routes
  if (!userId && isProtectedRoute(req)) {
    const { redirectToSignIn } = await auth();
    return redirectToSignIn();
  }

  return NextResponse.next();
});

// ✅ Combine both middlewares
export default createMiddleware(aj, clerk);

// ✅ Match all routes except static files (correct for App Router)
export const config = {
  matcher: [
    // Match everything except Next.js internals and static assets
    "/((?!_next|.*\\..*|favicon.ico).*)",
    // Always include API and server action routes
    "/(api|trpc)(.*)",
  ],
};
