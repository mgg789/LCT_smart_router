import {
  Body,
  Controller,
  Get,
  Logger,
  type MessageEvent,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  catchError,
  EMPTY,
  endWith,
  ignoreElements,
  interval,
  map,
  merge,
  Observable,
  share,
  takeUntil,
} from 'rxjs';
import { EvidenceReader } from '../ai/explain';
import { ChatEventBus, type DispatchChatRow, DispatchChatsService } from '../ai/runtime';
import { type Actor, CurrentActor, Roles } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import type { AiMessage } from '../generated/prisma/client';
import { OperationsService } from '../operations';
import { AlertsService } from '../orchestrator/alerts';
import { EngineersService } from '../orchestrator/engineers';
import {
  DATASET_REGIONS,
  DatasetImportService,
  UploadImportService,
} from '../orchestrator/imports';
import { LiveService } from '../orchestrator/live';
import { PolicyService } from '../orchestrator/policy';
import { RequestsService } from '../orchestrator/requests';
import { ResetService } from '../orchestrator/reset';
import { APP_STATE_KEYS, PrismaService } from '../persistence';
import {
  PUBLICATION_TRIGGERS,
  SnapshotBuilder,
  SnapshotPublisher,
} from '../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  ManualPlanService,
  ResultAcceptanceService,
  RouterClient,
} from '../routing/router-gateway';
import {
  type AiConversationView,
  type AiMessageView,
  toConversationView,
  toMessageView,
} from './ai-view';
import { chatEventStream, toChatMessageEvent } from './chat-stream';
import { type DispatchChatView, toDispatchChatView } from './dispatch-chat-view';
import {
  type CloseShiftDto,
  closeShiftSchema,
  type ResolveAlertDto,
  resolveAlertSchema,
} from './dto/alert.dto';
import {
  type ImportDatasetDto,
  importDatasetSchema,
  type ResetDto,
  resetSchema,
  type UploadDataPackageDto,
  uploadDataPackageSchema,
} from './dto/data.dto';
import {
  type FinishDispatchChatDto,
  finishDispatchChatSchema,
  type ListDispatchChatsQueryDto,
  listDispatchChatsQuerySchema,
  type OpenDispatchChatDto,
  openDispatchChatSchema,
  type ReadDispatchChatDto,
  readDispatchChatSchema,
  type SendDispatchChatMessageDto,
  sendDispatchChatMessageSchema,
} from './dto/dispatch-chat.dto';
import {
  type CreateEngineerDto,
  createEngineerSchema,
  type LinkEngineerAccountDto,
  linkEngineerAccountSchema,
  operationOnlySchema,
  type SetAvailabilityDto,
  type SetWorkdayDto,
  setAvailabilitySchema,
  setWorkdaySchema,
  type UnlinkEngineerAccountDto,
  type UpdateEngineerDto,
  unlinkEngineerAccountSchema,
  updateEngineerSchema,
} from './dto/engineer.dto';
import { type StartLiveWorkdayDto, startLiveWorkdaySchema } from './dto/live.dto';
import {
  type ReassignDto,
  type ReorderDto,
  reassignSchema,
  reorderSchema,
  type SetModeDto,
  type SubmitResultDto,
  setModeSchema,
  submitResultSchema,
} from './dto/plan.dto';
import { type SelectPolicyDto, selectPolicySchema } from './dto/policy.dto';
import {
  type CancelRequestDto,
  cancelRequestSchema,
  type DispatcherCreateRequestDto,
  type DispatcherUpdateRequestDto,
  dispatcherCreateRequestSchema,
  dispatcherUpdateRequestSchema,
} from './dto/request.dto';
import {
  type UpdateRouterTechnicalSettingsDto,
  updateRouterTechnicalSettingsSchema,
} from './dto/router.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';
import type { DispatchLiveView } from './live-view.types';
import { toPlanView } from './plan-view';
import { type RequestView, toRequestView } from './request-view';

/**
 * Dashboard contour.
 *
 * The dispatcher edits the conditions of the task and the data behind it. In AUTO that is
 * never a direct write of an assignment: changing a condition forms a new planning task,
 * and Router discovers it on its own (context/32 section 6.3).
 */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly requests: RequestsService,
    private readonly engineers: EngineersService,
    private readonly alertsService: AlertsService,
    private readonly policyService: PolicyService,
    private readonly publisher: SnapshotPublisher,
    private readonly builder: SnapshotBuilder,
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
    private readonly manual: ManualPlanService,
    private readonly acceptance: ResultAcceptanceService,
    private readonly router: RouterClient,
    private readonly imports: DatasetImportService,
    private readonly uploadImports: UploadImportService,
    private readonly resetService: ResetService,
    private readonly config: AppConfigService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly live: LiveService,
    private readonly evidence: EvidenceReader,
    private readonly dispatchChats: DispatchChatsService,
    private readonly chatBus: ChatEventBus,
  ) {}

  private readonly logger = new Logger(DispatchController.name);

  @Get('live')
  @ApiOperation({ summary: 'Durable LIVE workday state for the dispatcher dashboard' })
  async liveView(): Promise<DispatchLiveView> {
    return this.live.dispatchView();
  }

  @Post('live/start')
  @ApiOperation({ summary: 'Start the current LIVE workday and publish its t=0 task' })
  async startLive(
    @CurrentActor() actor: Actor,
    @Body(zodBody(startLiveWorkdaySchema)) dto: StartLiveWorkdayDto,
  ): Promise<DispatchLiveView> {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'live.workday.start', payload: dto },
      async (context) => this.live.start(context),
    );
    return outcome.result;
  }

  /**
   * The dispatcher's chat list: dialogues a human is carrying right now, plus the ones
   * they have already finished.
   *
   * Finished chats stay because ending one is not deleting it (context/36 section 9.3) --
   * the dispatcher has to be able to re-read what was agreed with a customer at eleven
   * o'clock. A closed row shows the dialogue as it stood when it was closed, never the
   * messages the assistant has exchanged since.
   *
   * Opening this page is a read and changes nothing: it is explicitly not what switches
   * the agent off (context/36 section 9.1, «Открытие вкладки диспетчером не является
   * условием выключения агента»).
   */
  @Get('chats')
  @ApiOperation({ summary: 'Chats with clients and engineers: live ones, then finished ones' })
  async listChats(
    @Query(zodBody(listDispatchChatsQuerySchema)) query: ListDispatchChatsQueryDto,
  ): Promise<{ chats: DispatchChatView[] }> {
    const rows = await this.dispatchChats.list({ closedLimit: query.closedLimit });
    return { chats: rows.map(toDispatchChatView) };
  }

  /**
   * Server-sent events for every chat a human is carrying: each message as it is written,
   * and each change of hands.
   *
   * Carries no catch-up read of its own. A dispatcher's list is a page of many dialogues,
   * and the honest way to resume it after a gap is `GET /dispatch/chats`, which returns
   * every episode with its unread count already computed -- replaying a per-conversation
   * cursor here would mean the browser holding one cursor per chat and still having to
   * refetch for any chat it had not yet seen.
   */
  @Sse('chats/events')
  @ApiOperation({ summary: 'Live messages across every chat handed to the dispatcher' })
  chatEvents(): Observable<MessageEvent> {
    const heartbeatMs = this.config.get('AI_SSE_HEARTBEAT_MS');
    const heartbeat$: Observable<MessageEvent> = interval(heartbeatMs).pipe(
      map(() => ({ type: 'heartbeat', data: {} }) satisfies MessageEvent),
    );

    const main$: Observable<MessageEvent> = chatEventStream({
      live: this.chatBus.inbox(),
      replay: async () => [],
    }).pipe(
      map(toChatMessageEvent),
      catchError((error: unknown) => {
        // After SSE headers are sent the global exception filter can only produce
        // `ERR_HTTP_HEADERS_SENT` and a dead socket, so this stream never errors: it ends,
        // which is what an ordinary network drop looks like, and the browser reconnects and
        // refetches the list.
        this.logger.error(
          `Dispatcher chat stream failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return EMPTY;
      }),
      share(),
    );
    const stop$ = main$.pipe(ignoreElements(), endWith(true));

    return merge(main$, heartbeat$).pipe(takeUntil(stop$));
  }

  /**
   * Opens a chat with the client of a request, or with an engineer, from the dashboard.
   *
   * This is the second way a chat begins -- the first is the assistant deciding it needs a
   * human and calling `call_dispatch_helper`. Both end in the same place: one `AiHandoff`
   * over the person's own dialogue, so their history is in front of the dispatcher from the
   * first moment and the answer lands where they are already looking.
   *
   * Pressing the button again while the chat is already open returns it rather than
   * failing: that is what the dispatcher meant by pressing it.
   */
  @Post('chats')
  @ApiOperation({ summary: 'Open a chat with a request customer or an engineer' })
  async openChat(
    @CurrentActor() actor: Actor,
    @Body(zodBody(openDispatchChatSchema)) dto: OpenDispatchChatDto,
  ): Promise<{ chat: DispatchChatView }> {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.open',
        payload: dto,
      },
      async (context) => {
        const opened = await this.dispatchChats.openWithTarget(
          context.tx,
          context.now,
          dispatcherAccountId,
          dto.target,
          dto.text,
        );
        return {
          handoffId: opened.handoff.id,
          messageIds: opened.messages.map((message) => message.id),
          created: opened.created,
        };
      },
    );

    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) {
      if (outcome.result.created) {
        this.publishChatState(chat);
      }
      this.publishChatMessages(chat, outcome.result.messageIds);
    }
    return { chat: toDispatchChatView(chat) };
  }

  @Post('chats/:id/messages')
  @ApiOperation({ summary: "Send the dispatcher's own reply into a chat" })
  async sendChatMessage(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(sendDispatchChatMessageSchema)) dto: SendDispatchChatMessageDto,
  ): Promise<{ message: AiMessageView; chat: DispatchChatView }> {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.message.send',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const written = await this.dispatchChats.reply(
          context.tx,
          context.now,
          id,
          dispatcherAccountId,
          dto.text,
        );
        return { handoffId: written.handoff.id, messageId: written.message.id };
      },
    );

    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) {
      this.publishChatMessages(chat, [outcome.result.messageId]);
    }
    return {
      message: toMessageView(this.requireChatMessage(chat, outcome.result.messageId)),
      chat: toDispatchChatView(chat),
    };
  }

  /**
   * Ends a chat: the assistant takes the dialogue back and the row stays in the list.
   *
   * Nothing the dispatcher applied while they were carrying it is reverted -- a chat is a
   * conversation, not a transaction (context/36 section 9.3).
   */
  @Post('chats/:id/finish')
  @ApiOperation({ summary: 'End a chat: the AI resumes, history and applied actions stay' })
  async finishChat(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(finishDispatchChatSchema)) dto: FinishDispatchChatDto,
  ): Promise<{ conversation: AiConversationView; chat: DispatchChatView }> {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.finish',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const written = await this.dispatchChats.finish(
          context.tx,
          context.now,
          id,
          dispatcherAccountId,
        );
        return { handoffId: written.handoff.id, messageId: written.message.id };
      },
    );

    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) {
      this.publishChatMessages(chat, [outcome.result.messageId]);
      this.publishChatState(chat);
    }
    return { conversation: toConversationView(chat.conversation), chat: toDispatchChatView(chat) };
  }

  /**
   * Marks a chat read up to a message sequence, which is what clears its unread badge.
   *
   * The cursor only moves forward, so a second tab replaying an older value cannot bring
   * back a badge the first one cleared, and a chat that has already been finished is a
   * no-op -- there is nothing left to acknowledge.
   */
  @Post('chats/:id/read')
  @ApiOperation({ summary: 'Acknowledge a chat up to a message sequence' })
  async readChat(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(readDispatchChatSchema)) dto: ReadDispatchChatDto,
  ): Promise<{ chat: DispatchChatView | null }> {
    this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.read',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const handoff = await this.dispatchChats.markRead(context.tx, id, dto.seq);
        return { handoffId: handoff?.id ?? null };
      },
    );
    const handoffId = outcome.result.handoffId;
    if (!handoffId) {
      return { chat: null };
    }
    const chat = await this.dispatchChats.byHandoffId(handoffId);
    return { chat: chat ? toDispatchChatView(chat) : null };
  }

  /** The episode a write just changed, re-read so the response and the broadcast carry the
   *  committed state rather than the rows the handler started from. */
  private async requireChat(handoffId: string): Promise<DispatchChatRow> {
    const chat = await this.dispatchChats.byHandoffId(handoffId);
    if (!chat) {
      throw SysError.notFound('Chat', { handoffId });
    }
    return chat;
  }

  private requireChatMessage(chat: DispatchChatRow, messageId: string): AiMessage {
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    if (!message) {
      throw SysError.notFound('Message', { messageId });
    }
    return message;
  }

  /**
   * Announces the messages this request wrote, after the transaction that wrote them has
   * committed (`ChatEventBus`'s own note on why never inside it).
   *
   * Skipped entirely on a replayed retry: the first attempt already announced them, and a
   * customer seeing the dispatcher's sentence arrive twice would read it as the dispatcher
   * repeating themselves.
   */
  private publishChatMessages(chat: DispatchChatRow, messageIds: readonly string[]): void {
    for (const messageId of messageIds) {
      const message = chat.messages.find((candidate) => candidate.id === messageId);
      if (message) {
        this.chatBus.publishMessage({
          conversationId: chat.conversation.id,
          handoffId: chat.handoff.id,
          message,
        });
      }
    }
  }

  private publishChatState(chat: DispatchChatRow): void {
    this.chatBus.publishState({ conversation: chat.conversation, handoff: chat.handoff });
  }

  @Get('requests')
  @ApiOperation({ summary: 'Requests of the day, including started, finished and cancelled' })
  async list(
    @Query('lifecycle') lifecycle?: string,
    @Query('assignment') assignment?: string,
  ): Promise<{ requests: RequestView[] }> {
    const requests = await this.prisma.request.findMany({
      // Unlike the customer's list, this one keeps completed and cancelled work: the
      // dispatcher needs the whole day, not only what is still open (context/39 DB1).
      where: {
        ...(lifecycle ? { lifecycle: lifecycle as never } : {}),
        ...(assignment ? { assignmentState: assignment as never } : {}),
      },
      orderBy: [{ arrivalOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const live = await this.prisma.liveRequestState.findMany({
      where: { workday: { status: 'running' } },
      select: { requestId: true, assumedStartedAt: true, assumedCompletedAt: true },
    });
    const states = new Map(live.map((item) => [item.requestId, item]));
    return {
      requests: requests.map((request) => toRequestView(request, states.get(request.id) ?? null)),
    };
  }

  @Post('requests')
  @ApiOperation({ summary: 'Create a request on behalf of a customer' })
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(dispatcherCreateRequestSchema)) dto: DispatcherCreateRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.create',
        payload: dto,
      },
      async (context) => {
        const email = dto.clientEmail.trim().toLowerCase();
        const account = await context.tx.account.upsert({
          where: { email },
          update: {},
          create: {
            email,
            createdAt: BigInt(context.now),
            updatedAt: BigInt(context.now),
          },
        });
        // The account exists so the request has an owner and a real address to write to.
        // It is not marked as a verified address: only the customer's own login proves
        // that (context/41 section 10).
        await context.tx.accountRole.upsert({
          where: { accountId_role: { accountId: account.id, role: 'client' } },
          update: {},
          create: { accountId: account.id, role: 'client', grantedAt: BigInt(context.now) },
        });

        const prepared = await this.requests.prepare(context, account.id, {
          contactName: dto.contactName,
          addressText: dto.addressText,
          lat: dto.lat ?? null,
          lon: dto.lon ?? null,
          workType: dto.workType,
          ...(dto.requiredEquipment === undefined
            ? {}
            : { requiredEquipment: dto.requiredEquipment }),
          windowStartAt: dto.windowStartAt,
          windowEndAt: dto.windowEndAt,
          urgent: dto.urgent,
          problemText: dto.problemText ?? null,
        });
        // A request the dispatcher creates is already a task: there is no separate screen
        // for the customer to confirm content they did not type.
        return toRequestView(await this.requests.submit(context, prepared.id, prepared.version));
      },
    );
    return { request: outcome.result };
  }

  @Patch('requests/:id')
  @ApiOperation({ summary: 'Change the conditions of a request that has not started' })
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(dispatcherUpdateRequestSchema)) dto: DispatcherUpdateRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.update',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.updateConditions(context, id, dto.expectedVersion ?? null, {
            ...(dto.windowStartAt === undefined ? {} : { windowStartAt: dto.windowStartAt }),
            ...(dto.windowEndAt === undefined ? {} : { windowEndAt: dto.windowEndAt }),
            ...(dto.addressText === undefined ? {} : { addressText: dto.addressText }),
            ...(dto.lat === undefined ? {} : { lat: dto.lat }),
            ...(dto.lon === undefined ? {} : { lon: dto.lon }),
            ...(dto.urgent === undefined ? {} : { urgent: dto.urgent }),
            ...(dto.requiredEquipment === undefined
              ? {}
              : { requiredEquipment: dto.requiredEquipment }),
          }),
        ),
    );
    return { request: outcome.result };
  }

  @Post('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel a request that has not started' })
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(cancelRequestSchema)) dto: CancelRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.cancel',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.cancel(context, id, dto.expectedVersion ?? null, dto.reason ?? null),
        ),
    );
    return { request: outcome.result };
  }

  @Get('requests/:id/history')
  @ApiOperation({ summary: 'Previous conditions of a request' })
  async history(@Param('id') id: string) {
    const request = await this.prisma.request.findUnique({ where: { id } });
    if (!request) {
      throw SysError.notFound('Request', { requestId: id });
    }
    const entries = await this.prisma.requestConditionHistory.findMany({
      where: { requestId: id },
      orderBy: { changedAt: 'desc' },
    });
    return {
      // History is a journal of what the conditions used to be. It is never a second
      // active promise to the customer (context/36 section 4).
      history: entries.map((entry) => ({
        changedAt: Number(entry.changedAt),
        operationId: entry.operationId,
        reason: entry.reason,
        previous: entry.previous,
      })),
      asOf: this.clock.nowSeconds(),
    };
  }

  @Get('requests/:id/evidence')
  @ApiOperation({
    summary: 'Router evidence for one request: per-request facts and candidate[]/blockers[]',
  })
  async requestEvidence(@Param('id') id: string) {
    // The evidence package travels inside the applied plan's own stored Router result
    // (`RouterResult.payload.main_evidence`/`baseline_evidence`, `result.types.ts`'s own
    // note on why the loose object keeps them whole). A plan applied before evidence
    // existed -- or with no Router result at all -- has none: that is an honest empty
    // shape, never an invented one (docs/api.md section 10's "next contract").
    const plan = await this.plans.current(this.prisma);
    if (!plan?.routerResult) {
      return { requestId: id, main: null, baseline: null };
    }
    const pair = this.evidence.forRequest(plan.routerResult.payload, id);
    return { requestId: id, main: pair.main, baseline: pair.baseline };
  }

  @Get('engineers')
  @ApiOperation({ summary: 'Engineers with their skills, transport and current day' })
  async listEngineers(): Promise<{
    engineers: Array<EngineerView & { day: EngineerDayView | null }>;
  }> {
    const engineers = await this.prisma.engineer.findMany({
      where: { archivedAt: null },
      orderBy: { inputOrder: 'asc' },
      include: {
        account: { select: { email: true } },
        days: { orderBy: { workDate: 'desc' }, take: 1 },
      },
    });
    return {
      engineers: engineers.map((engineer) => ({
        ...toEngineerView(engineer),
        // Availability, the current day and the profile stay visibly separate; they are
        // never blended into one "working / offline / unassigned" status
        // (context/39 DB4).
        day: engineer.days[0] ? toDayView(engineer.days[0]) : null,
      })),
    };
  }

  @Post('engineers')
  @ApiOperation({ summary: 'Add an engineer by email address' })
  async createEngineer(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createEngineerSchema)) dto: CreateEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.create',
        payload: dto,
      },
      async (context) =>
        toEngineerView(
          await this.engineers.create(context, {
            email: dto.email,
            displayName: dto.displayName,
            skills: dto.skills,
            transportType: dto.transportType,
            region: dto.region ?? null,
            homeLat: dto.homeLat ?? null,
            homeLon: dto.homeLon ?? null,
          }),
        ),
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/link-account')
  @ApiOperation({ summary: 'Give an engineer profile that has no login its email address' })
  async linkEngineerAccount(
    @CurrentActor() actor: Actor,
    @Body(zodBody(linkEngineerAccountSchema)) dto: LinkEngineerAccountDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.link_account',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) =>
        toEngineerView(await this.engineers.linkAccount(context, dto.engineerId, dto.email)),
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/unlink-account')
  @ApiOperation({ summary: 'Remove the login from an engineer without deleting the profile' })
  async unlinkEngineerAccount(
    @CurrentActor() actor: Actor,
    @Body(zodBody(unlinkEngineerAccountSchema)) dto: UnlinkEngineerAccountDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.unlink_account',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) =>
        toEngineerView(await this.engineers.unlinkAccount(context, dto.engineerId)),
    );
    return { engineer: outcome.result };
  }

  @Patch('engineers/:id')
  @ApiOperation({ summary: 'Change the profile of an engineer' })
  async updateEngineer(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(updateEngineerSchema)) dto: UpdateEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.update_profile',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      // The same handler the engineer's own edit goes through, so the two meet the same
      // version check and neither overwrites the other silently (context/39 DB4).
      async (context) =>
        toEngineerView(
          await this.engineers.updateProfile(context, id, dto.expectedVersion ?? null, {
            ...(dto.displayName === undefined ? {} : { displayName: dto.displayName }),
            ...(dto.skills === undefined ? {} : { skills: dto.skills }),
            ...(dto.transportType === undefined ? {} : { transportType: dto.transportType }),
            ...(dto.region === undefined ? {} : { region: dto.region }),
            ...(dto.homeLat === undefined ? {} : { homeLat: dto.homeLat }),
            ...(dto.homeLon === undefined ? {} : { homeLon: dto.homeLon }),
          }),
        ),
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/:id/workday')
  @ApiOperation({ summary: 'Set the shift and lunch conditions of one working day' })
  async setWorkday(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(setWorkdaySchema)) dto: SetWorkdayDto,
  ): Promise<{ day: EngineerDayView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_workday',
        targetRef: id,
        payload: dto,
      },
      async (context) =>
        toDayView(
          await this.engineers.setWorkday(context, id, {
            workDate: dto.workDate,
            shiftStartAt: dto.shiftStartAt,
            shiftEndAt: dto.shiftEndAt,
            ...(dto.lunch === undefined ? {} : { lunch: dto.lunch }),
            ...(dto.lunchRequired === undefined ? {} : { lunchRequired: dto.lunchRequired }),
            ...(dto.attendanceOptOut === undefined
              ? {}
              : { attendanceOptOut: dto.attendanceOptOut }),
          }),
        ),
    );
    return { day: outcome.result };
  }

  @Post('engineers/:id/availability')
  @ApiOperation({ summary: 'Take an engineer off the line, or put them back on' })
  async setEngineerAvailability(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(setAvailabilitySchema)) dto: SetAvailabilityDto,
  ): Promise<{
    day: EngineerDayView;
    publication: { publicationId: string; inputHash: string; planningAsOf: number } | null;
  }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_availability',
        targetRef: id,
        payload: dto,
      },
      // Working availability only. It does not finish the work in hand and does not
      // reassign it (context/42 DF-06).
      async (context) =>
        toDayView(
          await this.live.setDispatcherAvailability(
            context,
            id,
            dto.availability,
            dto.expectedOnlineAt ?? null,
          ),
        ),
    );
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    return {
      day: outcome.result,
      publication: current
        ? {
            publicationId: current.snapshot.id,
            inputHash: current.snapshot.inputHash,
            planningAsOf: Number(current.snapshot.planningAsOf),
          }
        : null,
    };
  }

  @Post('engineers/:id/technical-break')
  @ApiOperation({ summary: 'Take an engineer off the line for a 15-minute technical stop' })
  async startEngineerTechnicalBreak(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(operationOnlySchema)) dto: { operationId: string },
  ): Promise<{ day: EngineerDayView }> {
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.technical_break',
        targetRef: id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.startTechnicalBreak(context, id)),
    );
    return { day: outcome.result };
  }

  @Get('router/technical-settings')
  @ApiOperation({ summary: 'Read Router-owned routing and execution controls' })
  async routerTechnicalSettings() {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    return this.router.getTechnicalSettings();
  }

  @Put('router/technical-settings')
  @ApiOperation({ summary: 'Replace Router-owned routing and execution controls' })
  async updateRouterTechnicalSettings(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateRouterTechnicalSettingsSchema)) dto: UpdateRouterTechnicalSettingsDto,
  ) {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    const requested = {
      operationId: dto.operationId,
      expectedContextVersion: dto.expectedContextVersion,
      lunchesEnabled: dto.lunchesEnabled,
      departureLatenessToleranceSec: dto.departureLatenessToleranceSec,
      taskStartLatenessToleranceSec: dto.taskStartLatenessToleranceSec,
      windowLatenessToleranceSec: dto.windowLatenessToleranceSec,
      trafficEnabled: dto.trafficEnabled,
      equipmentEnabled: dto.equipmentEnabled,
      travelTimeMode: dto.travelTimeMode,
      accessBufferSec: dto.accessBufferSec,
      fixedTravelTimeSec: dto.fixedTravelTimeSec,
      earlyFinishReplanThresholdSec: dto.earlyFinishReplanThresholdSec,
      taskOverrunToleranceSec: dto.taskOverrunToleranceSec,
    };
    const outcome = await this.operations.executeExternal(
      {
        operationId: dto.operationId,
        actor,
        action: 'router.technical-settings.replace',
        targetRef: 'router-core',
        expectedVersion: null,
        payload: dto,
      },
      // Router owns and persists these controls. The external-operation envelope journals
      // the intent first, then releases the sys transaction before this private HTTP call.
      () => this.router.updateTechnicalSettings(requested),
    );
    // Router's switch only permits lunch nodes. Daily engineer conditions provide the
    // actual lunch contract, including when a dispatcher enables it after LIVE started.
    await this.live.synchronizeGlobalLunchSwitch(dto.lunchesEnabled);
    return outcome.result;
  }

  @Get('policies')
  @ApiOperation({ summary: 'Prepared policies and the one in force' })
  async policies() {
    return {
      // A catalogue of prepared variants. There is no editor of weights, criteria order
      // or solver parameters here, and a rich policy structure in the contracts does not
      // create one (context/42 DF-15).
      policies: this.policyService.list(),
      active: await this.policyService.active(this.prisma),
    };
  }

  @Get('policy-comparison')
  @ApiOperation({ summary: 'Compare all prepared policies and FIFO on the current task' })
  async policyComparison() {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    const comparison = await this.router.getPolicyComparison();
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (
      !current ||
      current.snapshot.id !== comparison.inputPublicationId ||
      current.snapshot.inputHash !== comparison.inputHash
    ) {
      throw new SysError(
        'VERSION_CONFLICT',
        'Planning data changed while the policy comparison was calculated; retry the read',
      );
    }
    return comparison;
  }

  @Post('policy')
  @ApiOperation({ summary: 'Choose a prepared policy' })
  async selectPolicy(
    @CurrentActor() actor: Actor,
    @Body(zodBody(selectPolicySchema)) dto: SelectPolicyDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'policy.select',
        targetRef: dto.policyId,
        payload: dto,
      },
      async (context) => {
        const selected = await this.policyService.select(context, dto.policyId);
        // The choice is data of the task, so it is republished. A new criterion does not
        // mean a new plan is on screen yet: until a current result is accepted, the
        // chosen policy and the policy the shown plan was built with are different things
        // (context/42 DF-15).
        const publication = await this.publisher.publishIfChanged(
          context.tx,
          context.now,
          PUBLICATION_TRIGGERS.POLICY_CHANGED,
        );
        return { ...selected, publication };
      },
    );
    return outcome.result;
  }

  @Get('debug/snapshot')
  @ApiOperation({ summary: 'The published planning task, as Router reads it' })
  async debugSnapshot() {
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (!current) {
      // A valid state, not an error: nothing has yet changed the planning task.
      const pending = await this.builder.build(this.prisma, this.clock.nowSeconds());
      return { published: false, snapshot: null, diagnostics: pending.diagnostics };
    }
    // Diagnostics are rebuilt from the current state rather than read off the published
    // document. The reason is specific: a request that cannot be projected -- one still
    // waiting for coordinates -- does not change the task, so nothing is republished, and
    // a count frozen at publication time would never mention it. Building them live is a
    // read; it publishes nothing and moves no pointer.
    const live = await this.builder.build(this.prisma, this.clock.nowSeconds());

    return {
      published: true,
      publicationId: current.snapshot.id,
      publicationSeq: current.pointerVersion,
      inputHash: current.snapshot.inputHash,
      planningAsOf: Number(current.snapshot.planningAsOf),
      trigger: current.snapshot.trigger,
      generation: current.snapshot.generation,
      diagnostics: live.diagnostics,
      diagnosticsAtPublication: current.snapshot.diagnostics,
      // The exact bytes Router hashes, returned as text on purpose: re-encoding them
      // would defeat the point of storing them verbatim.
      payload: current.snapshot.payload,
    };
  }

  @Get('plan')
  @ApiOperation({ summary: 'The applied working plan and the control mode' })
  async plan() {
    const plan = await this.plans.current(this.prisma);
    const control = await this.control.current(this.prisma);
    const lastPackage = await this.acceptance.lastPackage();

    return {
      mode: control.mode,
      modeVersion: control.modeVersion,
      // The moment the shown plan describes. While a recalculation is under way the
      // interface keeps this plan and says it is being rebuilt, rather than clearing the
      // day (context/36 section 6).
      plan: plan ? toPlanView(plan) : null,
      // Direct relation to the package that produced the working revision. Unlike the
      // diagnostic last package, this cannot be confused by another result received in
      // the same second.
      appliedResult: plan?.routerResult
        ? {
            resultId: plan.routerResult.resultId,
            inputHash: plan.routerResult.inputHash,
            routerContextVersion: plan.routerResult.routerContextVersion,
          }
        : null,
      lastResult: lastPackage
        ? {
            resultId: lastPackage.resultId,
            inputHash: lastPackage.inputHash,
            routerContextVersion: lastPackage.routerContextVersion,
            accepted: lastPackage.accepted,
            // Why a finished result did not become the working plan, kept so a refusal is
            // explainable rather than invisible.
            rejectionCode: lastPackage.rejectionCode,
            receivedAt: Number(lastPackage.receivedAt),
          }
        : null,
    };
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Explainable problems reported by the plan' })
  async alerts(@Query('workDate') workDate?: string) {
    if (workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      throw new SysError('VALIDATION_FAILED', 'workDate must be YYYY-MM-DD');
    }
    return { alerts: await this.alertsService.list(workDate) };
  }

  @Post('alerts/:id/seen')
  @ApiOperation({ summary: 'Mark an alert as seen' })
  async markAlertSeen(@Param('id') id: string) {
    // Seen is not resolved. The underlying condition is unchanged, and it clears only when
    // the real state changes (context/39 DB2).
    await this.alertsService.markSeen(id, this.clock.nowSeconds());
    return { seen: true };
  }

  @Post('notices/:id/seen')
  @ApiOperation({ summary: 'Mark an informational notice as seen without resolving any alert' })
  async markNoticeSeen(@Param('id') id: string) {
    await this.alertsService.markSeen(id, this.clock.nowSeconds());
    return { seen: true };
  }

  @Post('alerts/:id/resolve')
  @ApiOperation({ summary: 'Apply one dispatcher-selected alert resolution atomically' })
  async resolveAlert(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(resolveAlertSchema)) dto: ResolveAlertDto,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'alert.resolve', targetRef: id, payload: dto },
      (context) => this.alertsService.resolve(context, id, dto),
    );
    return { alert: outcome.result };
  }

  @Get('shift')
  @ApiOperation({ summary: 'Day close status; open alerts are a hard close gate' })
  async shift(@Query('workDate') workDate?: string) {
    if (!workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      throw new SysError('VALIDATION_FAILED', 'workDate must be YYYY-MM-DD');
    }
    return this.alertsService.shiftStatus(workDate);
  }

  @Post('shift/close')
  @ApiOperation({ summary: 'Close a day only when every blocking alert has an outcome' })
  async closeShift(
    @CurrentActor() actor: Actor,
    @Body(zodBody(closeShiftSchema)) dto: CloseShiftDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'shift.close',
        targetRef: dto.workDate,
        payload: dto,
      },
      (context) => this.alertsService.closeShift(context, dto.workDate),
    );
    return outcome.result;
  }

  @Post('mode')
  @ApiOperation({ summary: 'Switch emergency manual control on or off' })
  async setMode(@CurrentActor() actor: Actor, @Body(zodBody(setModeSchema)) dto: SetModeDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `control.${dto.mode}`,
        payload: dto,
      },
      async (context) =>
        dto.mode === 'manual'
          ? this.control.enterManual(context)
          : this.control.returnToAuto(context),
    );
    return { control: outcome.result };
  }

  @Post('plan/reassign')
  @ApiOperation({ summary: 'Move work that has not started to another engineer' })
  async reassign(@CurrentActor() actor: Actor, @Body(zodBody(reassignSchema)) dto: ReassignDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'plan.reassign',
        targetRef: dto.requestId,
        payload: dto,
      },
      async (context) => this.manual.reassign(context, dto.requestId, dto.engineerId),
    );
    return outcome.result;
  }

  @Post('plan/reorder')
  @ApiOperation({ summary: "Save the finished order of one engineer's queue" })
  async reorder(@CurrentActor() actor: Actor, @Body(zodBody(reorderSchema)) dto: ReorderDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'plan.reorder',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) => this.manual.reorder(context, dto.engineerId, dto.requestIds),
    );
    return outcome.result;
  }

  @Post('debug/router-result')
  @ApiOperation({
    summary: 'Feed a Router result through the acceptance checks (debug contour)',
  })
  async submitResult(@Body(zodBody(submitResultSchema)) dto: SubmitResultDto) {
    // The production path is the opposite direction: sys polls Router. This endpoint
    // exists only while that client does not, and it runs the identical checks -- it is a
    // way in for a test, not a second way to apply a plan (context/41 section 6.3).
    return this.acceptance.accept(dto.result, dto.activeContextVersion ?? null);
  }

  @Get('data/state')
  @ApiOperation({ summary: 'Whether the application has been initialised, and how' })
  async dataState() {
    const state = await this.prisma.appState.findMany({
      where: {
        key: {
          in: [
            APP_STATE_KEYS.INITIALIZED,
            APP_STATE_KEYS.STARTUP_PROFILE,
            APP_STATE_KEYS.GENERATION,
          ],
        },
      },
    });
    const byKey = new Map(state.map((row) => [row.key, row.value]));
    const packages = await this.prisma.importPackage.findMany({
      orderBy: { appliedAt: 'desc' },
      take: 20,
    });
    const [depots, requestRegions, engineerRegions] = await Promise.all([
      this.prisma.depot.findMany({ select: { region: true } }),
      this.prisma.request.findMany({
        where: { region: { not: null } },
        distinct: ['region'],
        select: { region: true },
      }),
      this.prisma.engineer.findMany({
        where: { region: { not: null }, archivedAt: null },
        distinct: ['region'],
        select: { region: true },
      }),
    ]);
    const availableRegions = [
      ...new Set(
        [...depots, ...requestRegions, ...engineerRegions].flatMap((item) =>
          item.region === null ? [] : [item.region],
        ),
      ),
    ].sort();
    return {
      // An empty `requests` table is not proof that setup never happened; after a
      // deliberate empty reset it is the intended state (context/37 section 9.5).
      initialized: byKey.get(APP_STATE_KEYS.INITIALIZED) ?? false,
      startupProfile: byKey.get(APP_STATE_KEYS.STARTUP_PROFILE) ?? null,
      generation: byKey.get(APP_STATE_KEYS.GENERATION) ?? 1,
      availableRegions,
      imports: packages.map((item) => ({
        source: item.source,
        checksum: item.checksum,
        appliedAt: Number(item.appliedAt),
        summary: item.summary,
      })),
    };
  }

  @Post('data/upload')
  @ApiOperation({ summary: 'Atomically load a new region or append requests from JSON' })
  async uploadData(
    @CurrentActor() actor: Actor,
    @Body(zodBody(uploadDataPackageSchema)) dto: UploadDataPackageDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.upload',
        targetRef: dto.region,
        payload: dto,
      },
      async (context) =>
        this.uploadImports.importPackage(
          context,
          dto,
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
        ),
    );
    return outcome.result;
  }

  @Post('data/import')
  @ApiOperation({ summary: 'Atomically load one, several or all official dataset regions' })
  async importDataset(
    @CurrentActor() actor: Actor,
    @Body(zodBody(importDatasetSchema)) dto: ImportDatasetDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.import',
        targetRef: dto.region ?? (dto.regions === 'all' ? 'all' : dto.regions?.join(',')),
        payload: dto,
      },
      async (context) => {
        const regions = dto.region
          ? [dto.region]
          : dto.regions === 'all'
            ? [...DATASET_REGIONS]
            : (dto.regions ?? []);
        return this.imports.importRegions(
          context,
          regions,
          this.config.get('DATASET_ROOT'),
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
          dto.engineerCountPerRegion ?? {},
        );
      },
    );
    return outcome.result;
  }

  @Post('data/reset')
  @ApiOperation({ summary: 'Reset to the test data, or to an empty working set' })
  async reset(@CurrentActor() actor: Actor, @Body(zodBody(resetSchema)) dto: ResetDto) {
    if (actor.kind !== 'account') {
      // A destructive reset is a confirmed human action. An integration key carries the
      // dispatcher's authority but not their confirmation (context/42 DF-24).
      throw SysError.forbidden('A reset is confirmed from the Dashboard');
    }
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `data.reset.${dto.kind}`,
        payload: dto,
        confirmation: dto.confirmation,
      },
      async (context) => this.resetService.run(context, dto.kind, dto.confirmation),
    );
    return outcome.result;
  }

  /** A dispatcher chat reply or "Завершить передачу" needs a real human behind it, the
   *  same confirmation `reset` above requires: an integration key carries the dispatcher's
   *  authority but not a person who could actually be answering a customer. */
  private requireDispatcherAccount(actor: Actor): string {
    if (actor.kind !== 'account' || !actor.accountId) {
      throw SysError.forbidden('A dispatcher chat reply is confirmed from the Dashboard');
    }
    return actor.accountId;
  }
}
