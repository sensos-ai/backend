import { z } from "zod";
declare const SENSOS_PROTOCOL_VERSIONS: readonly [1];
declare const LATEST_SENSOS_PROTOCOL_VERSION: 1;
type SensosProtocolVersion = (typeof SENSOS_PROTOCOL_VERSIONS)[number];
declare const protocolVersionSchema: z.ZodNumber;
declare const supportedProtocolVersionsSchema: z.ZodArray<z.ZodNumber>;
declare const protocolDiscoverySchema: z.ZodObject<{
	protocolVersion: z.ZodNumber;
	supportedProtocolVersions: z.ZodArray<z.ZodNumber>;
}, z.core.$strip>;
type ProtocolDiscovery = z.infer<typeof protocolDiscoverySchema>;
declare function negotiateProtocolVersion(requested: readonly number[]): SensosProtocolVersion | undefined;
declare const sessionActorKeySchema: z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString], null>;
type SessionActorKey = z.infer<typeof sessionActorKeySchema>;
declare function sessionActorKey(input: {
	tenantId: string;
	userId: string;
	sessionId: string;
}): SessionActorKey;
declare const protocolErrorCodeSchema: z.ZodEnum<{
	conflict: "conflict";
	credentials_required: "credentials_required";
	forbidden: "forbidden";
	internal: "internal";
	invalid_request: "invalid_request";
	not_found: "not_found";
	protocol_mismatch: "protocol_mismatch";
	unauthorized: "unauthorized";
	unavailable: "unavailable";
}>;
declare const protocolErrorSchema: z.ZodObject<{
	code: z.ZodEnum<{
		conflict: "conflict";
		credentials_required: "credentials_required";
		forbidden: "forbidden";
		internal: "internal";
		invalid_request: "invalid_request";
		not_found: "not_found";
		protocol_mismatch: "protocol_mismatch";
		unauthorized: "unauthorized";
		unavailable: "unavailable";
	}>;
	message: z.ZodString;
	retryable: z.ZodDefault<z.ZodBoolean>;
	details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
type ProtocolError = z.infer<typeof protocolErrorSchema>;
import { z as z2 } from "zod";
declare const modelProviderSchema: z2.ZodEnum<{
	codex: "codex";
	gateway: "gateway";
}>;
declare const modelRefSchema: z2.ZodObject<{
	provider: z2.ZodEnum<{
		codex: "codex";
		gateway: "gateway";
	}>;
	modelId: z2.ZodString;
}, z2.core.$strip>;
type ModelProvider = z2.infer<typeof modelProviderSchema>;
type ModelRef = z2.infer<typeof modelRefSchema>;
declare const harnessFeaturesSchema: z2.ZodObject<{
	useMockModel: z2.ZodBoolean;
}, z2.core.$strip>;
type HarnessFeatures = z2.output<typeof harnessFeaturesSchema>;
type HarnessFeatureOverrides = Partial<HarnessFeatures>;
import { AnyDatabaseProvider } from "rivetkit/db";
import { ActorDefinition, Registry } from "rivetkit";
import { ChatStatus, UIMessage, UIMessageChunk } from "ai";
import { z as z3 } from "zod";
import { UIDataTypes as UIDataTypes_xvay7v } from "ai";
import { UITools as UITools_4y7ijr } from "ai";
declare const runStatusSchema: z3.ZodEnum<{
	cancel_requested: "cancel_requested";
	cancelled: "cancelled";
	completed: "completed";
	failed: "failed";
	interrupted: "interrupted";
	queued: "queued";
	running: "running";
}>;
type RunStatus = z3.infer<typeof runStatusSchema>;
type SessionStatus = "idle" | RunStatus;
declare const sessionInputSchema: z3.ZodObject<{
	supportedProtocolVersions: z3.ZodArray<z3.ZodNumber>;
	sessionId: z3.ZodString;
	catalogRevision: z3.ZodOptional<z3.ZodNumber>;
	cwd: z3.ZodString;
	model: z3.ZodOptional<z3.ZodObject<{
		provider: z3.ZodEnum<{
			codex: "codex";
			gateway: "gateway";
		}>;
		modelId: z3.ZodString;
	}, z3.core.$strip>>;
	instructions: z3.ZodOptional<z3.ZodString>;
	initialMessages: z3.ZodOptional<z3.ZodArray<z3.ZodCustom<UIMessage<unknown, UIDataTypes_xvay7v, UITools_4y7ijr>, UIMessage<unknown, UIDataTypes_xvay7v, UITools_4y7ijr>>>>;
	features: z3.ZodOptional<z3.ZodObject<{
		useMockModel: z3.ZodOptional<z3.ZodBoolean>;
	}, z3.core.$strip>>;
}, z3.core.$strip>;
type SessionInput = z3.input<typeof sessionInputSchema>;
type RunCommand = {
	idempotencyId: string;
	model?: ModelRef;
	message: UIMessage;
};
type SessionRun = {
	id: string;
	idempotencyId: string;
	status: RunStatus;
	model?: ModelRef;
	error?: string;
};
type InboxMessage = {
	id: string;
	priority: "now" | "next" | "adaptive";
	message: UIMessage;
	createdAt: number;
	origin: {
		type: "client";
		clientId: string;
	} | {
		type: "session";
		sessionId: string;
	} | {
		type: "system";
	};
};
type RunCompletion = {
	accepted: boolean;
	deduplicated: boolean;
	runId: string;
	status: RunStatus;
	reason?: "session_busy";
};
type SessionSnapshot = {
	protocolVersion: number;
	messages: UIMessage[];
	revision: number;
	runStatus: SessionStatus;
	status: ChatStatus;
	activeRunId?: string;
	model?: ModelRef;
	features: HarnessFeatures;
	title?: string;
	error?: string;
};
type SessionActions = {
	cancel: {
		input: {
			runId: string;
		};
		output: {
			cancelled: boolean;
			runId: string;
		};
	};
	deliver: {
		input: InboxMessage;
		output: DeliveryRoutedEvent;
	};
	deleteSession: {
		input: undefined;
		output: undefined;
	};
	getSession: {
		input: undefined;
		output: SessionSnapshot;
	};
	setModel: {
		input: ModelRef;
		output: {
			model: ModelRef;
		};
	};
	setFeatures: {
		input: HarnessFeatures;
		output: {
			features: HarnessFeatures;
		};
	};
	getRun: {
		input: {
			runId: string;
		};
		output: SessionRun | undefined;
	};
	streamSnapshot: {
		input: {
			runId: string;
			afterSeq?: number;
		};
		output: {
			run: SessionRun | undefined;
			frames: FrameEvent[];
		};
	};
};
type SessionQueues = {
	runs: {
		input: RunCommand;
		output: RunCompletion;
	};
	inbox: {
		input: InboxMessage;
		output: never;
	};
};
type FrameEvent = {
	runId: string;
	seq: number;
	chunk: UIMessageChunk;
};
type StatusChangedEvent = {
	runId?: string;
	runStatus: SessionStatus;
	status: ChatStatus;
	error?: string;
};
type DeliveryRoutedEvent = {
	id: string;
	status: "queued" | "started" | "steered" | "refused";
	runId?: string;
	reason?: "waiting_for_input" | "session_busy" | "not_active";
	origin: InboxMessage["origin"];
};
type SessionEvents = {
	frame: FrameEvent;
	statusChanged: StatusChangedEvent;
	messagesChanged: {
		messages: UIMessage[];
		revision: number;
	};
	titleChanged: {
		title: string;
	};
	deliveryRouted: DeliveryRoutedEvent;
};
import { ChatStatus as ChatStatus2, UIMessage as UIMessage2 } from "ai";
type PublicAction<
	Args extends unknown[],
	Output
> = (context: any, ...args: Args) => Output | Promise<Output>;
type SensosSessionEvents = {
	frame: {
		readonly _eventType?: FrameEvent;
	};
	statusChanged: {
		readonly _eventType?: StatusChangedEvent;
	};
	messagesChanged: {
		readonly _eventType?: {
			messages: UIMessage2[];
			revision: number;
		};
	};
	titleChanged: {
		readonly _eventType?: {
			title: string;
		};
	};
	deliveryRouted: {
		readonly _eventType?: DeliveryRoutedEvent;
	};
};
type SensosSessionQueues = {
	runs: {
		readonly _queueMessage?: RunCommand;
		readonly _queueComplete?: RunCompletion;
	};
	inbox: {
		readonly _queueMessage?: InboxMessage;
	};
};
type SensosSessionActions = {
	cancel: PublicAction<[runId: string], {
		cancelled: boolean;
		runId: string;
	}>;
	deliver: PublicAction<[message: InboxMessage], DeliveryRoutedEvent>;
	deleteSession: PublicAction<[], void>;
	getSession: PublicAction<[], SessionSnapshot>;
	setModel: PublicAction<[model: ModelRef], {
		model: ModelRef;
	}>;
	setFeatures: PublicAction<[features: HarnessFeatures], {
		features: HarnessFeatures;
	}>;
	getRun: PublicAction<[runId: string], SessionRun | undefined>;
	streamSnapshot: PublicAction<[runId: string, afterSeq?: number], {
		run: SessionRun | undefined;
		frames: FrameEvent[];
	}>;
};
type SensosSessionActor = ActorDefinition<unknown, {
	clientId: string;
	authToken?: string;
}, {
	clientId: string;
	userId?: string;
}, unknown, SessionInput, AnyDatabaseProvider, SensosSessionEvents, SensosSessionQueues, SensosSessionActions>;
type SensosRegistryActors = {
	session: SensosSessionActor;
};
type SensosRegistry = Registry<SensosRegistryActors>;
type SessionConnectionStatus = ChatStatus2;
import { UIMessageChunk as UIMessageChunk2 } from "ai";
import { z as z4 } from "zod";
declare const runStreamCursorSchema: z4.ZodString;
type RunStreamCursor = z4.infer<typeof runStreamCursorSchema>;
declare const runStreamName: (runId: string) => string;
type RunStreamChunk = {
	runId: string;
	sequence: number;
	chunk: UIMessageChunk2;
	cursor?: RunStreamCursor;
};
export { DeliveryRoutedEvent, FrameEvent, HarnessFeatureOverrides, HarnessFeatures, InboxMessage, LATEST_SENSOS_PROTOCOL_VERSION, ModelProvider, ModelRef, ProtocolDiscovery, ProtocolError, RunCommand, RunCompletion, RunStatus, RunStreamChunk, RunStreamCursor, SENSOS_PROTOCOL_VERSIONS, SensosProtocolVersion, SensosRegistry, SensosRegistryActors, SensosSessionActions, SensosSessionActor, SensosSessionEvents, SensosSessionQueues, SessionActions, SessionActorKey, SessionConnectionStatus, SessionEvents, SessionInput, SessionQueues, SessionRun, SessionSnapshot, SessionStatus, StatusChangedEvent, harnessFeaturesSchema, modelProviderSchema, modelRefSchema, negotiateProtocolVersion, protocolDiscoverySchema, protocolErrorCodeSchema, protocolErrorSchema, protocolVersionSchema, runStatusSchema, runStreamCursorSchema, runStreamName, sessionActorKey, sessionActorKeySchema, sessionInputSchema, supportedProtocolVersionsSchema };
