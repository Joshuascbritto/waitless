CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('owner', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_counters" (
	"tenant_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"day" date NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "queue_counters_queue_id_day_pk" PRIMARY KEY("queue_id","day")
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"prefix" char(1) DEFAULT 'A' NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"active_servers" integer DEFAULT 1 NOT NULL,
	"default_service_minutes" integer DEFAULT 15 NOT NULL,
	"notify_when_ahead" integer DEFAULT 2 NOT NULL,
	"no_show_after_minutes" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queues_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "queues_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "queues_active_servers_check" CHECK ("queues"."active_servers" > 0),
	CONSTRAINT "queues_default_service_minutes_check" CHECK ("queues"."default_service_minutes" > 0),
	CONSTRAINT "queues_notify_when_ahead_check" CHECK ("queues"."notify_when_ahead" >= 0),
	CONSTRAINT "queues_no_show_after_minutes_check" CHECK ("queues"."no_show_after_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Bahia' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_type_check" CHECK ("ticket_events"."type" in ('joined', 'called', 'pushed_back', 'serving', 'done', 'no_show', 'cancelled', 'removed', 'notified')),
	CONSTRAINT "ticket_events_actor_type_check" CHECK ("ticket_events"."actor_type" in ('customer', 'staff', 'system'))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"public_token" text NOT NULL,
	"number" integer NOT NULL,
	"display_code" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"device_id" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"sort_key" numeric NOT NULL,
	"push_count" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_at" timestamp with time zone,
	"serving_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"called_by" uuid,
	CONSTRAINT "tickets_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "tickets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tickets_source_check" CHECK ("tickets"."source" in ('qr', 'walk_in')),
	CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" in ('waiting', 'called', 'serving', 'done', 'no_show', 'cancelled', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_counters" ADD CONSTRAINT "queue_counters_queue_fk" FOREIGN KEY ("tenant_id","queue_id") REFERENCES "public"."queues"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_called_by_users_id_fk" FOREIGN KEY ("called_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_queue_fk" FOREIGN KEY ("tenant_id","queue_id") REFERENCES "public"."queues"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_ticket_id_idx" ON "push_subscriptions" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_idx" ON "ticket_events" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_events_queue_id_at_idx" ON "ticket_events" USING btree ("queue_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_events_notified_once_idx" ON "ticket_events" USING btree ("ticket_id",("payload" ->> 'kind')) WHERE "ticket_events"."type" = 'notified';--> statement-breakpoint
CREATE INDEX "tickets_queue_status_sort_idx" ON "tickets" USING btree ("queue_id","status","sort_key");--> statement-breakpoint
CREATE INDEX "tickets_waiting_order_idx" ON "tickets" USING btree ("queue_id","sort_key","id") WHERE "tickets"."status" = 'waiting';