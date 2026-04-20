import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return new Response(
        JSON.stringify({ error: "Email is required." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const MAILERLITE_API_KEY = Netlify.env.get("MAILERLITE_API_KEY");
    const MAILERLITE_GROUP_ID = Netlify.env.get("MAILERLITE_GROUP_ID");

    if (!MAILERLITE_API_KEY || !MAILERLITE_GROUP_ID) {
      console.error("Missing MAILERLITE_API_KEY or MAILERLITE_GROUP_ID env vars");
      return new Response(
        JSON.stringify({ error: "Server configuration error." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const mlResponse = await fetch(
      `https://connect.mailerlite.com/api/subscribers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MAILERLITE_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          email,
          groups: [MAILERLITE_GROUP_ID],
          status: "active",
        }),
      }
    );

    if (!mlResponse.ok) {
      const errorData = await mlResponse.json();
      console.error("MailerLite API error:", errorData);

      if (mlResponse.status === 422) {
        return new Response(
          JSON.stringify({ success: true, message: "Already subscribed." }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ error: "Failed to subscribe. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: "Subscribed successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Newsletter function error:", err);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/newsletter",
};
