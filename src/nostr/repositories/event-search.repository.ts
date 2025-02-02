import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isNil } from 'lodash';
import { Index, MeiliSearch } from 'meilisearch';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Config } from '../../config';
import { Event, SearchFilter } from '../entities';
import { TEventIdWithScore } from '../types';
import { getTimestampInSeconds } from '../utils';

type EventDocument = {
  id: string;
  pubkey: string;
  author: string;
  createdAt: number;
  kind: number;
  tags: string[][];
  genericTags: string[];
  content: string;
  sig: string;
  expiredAt: number | null;
  dTagValue: string | null;
};

type EventSearchRepositoryFilter = Pick<
  SearchFilter,
  | 'ids'
  | 'authors'
  | 'dTagValues'
  | 'genericTagsCollection'
  | 'kinds'
  | 'limit'
  | 'search'
  | 'searchOptions'
  | 'since'
  | 'until'
>;

@Injectable()
export class EventSearchRepository implements OnApplicationBootstrap {
  private readonly index?: Index<EventDocument>;
  private readonly syncEventKinds: number[];

  constructor(
    @InjectPinoLogger(EventSearchRepository.name)
    private readonly logger: PinoLogger,
    configService: ConfigService<Config, true>,
  ) {
    const { host, apiKey, syncEventKinds } = configService.get('meiliSearch', {
      infer: true,
    });
    this.syncEventKinds = syncEventKinds;

    if (!host || !apiKey) return;

    this.index = new MeiliSearch({ host, apiKey }).index('events');
  }

  async onApplicationBootstrap() {
    if (!this.index) return;

    await this.index.updateSettings({
      searchableAttributes: ['content'],
      filterableAttributes: [
        'id',
        'author',
        'createdAt',
        'kind',
        'genericTags',
        'delegator',
        'expiredAt',
        'dTagValue',
      ],
      sortableAttributes: ['createdAt'],
      rankingRules: [
        'sort',
        'words',
        'typo',
        'proximity',
        'attribute',
        'exactness',
        'createdAt:desc',
      ],
    });
  }

  async find(filter: EventSearchRepositoryFilter): Promise<Event[]> {
    if (!this.index) return [];

    const limit = this.getLimitFrom(filter);
    if (limit === 0) return [];

    const searchFilters = this.buildSearchFilters(filter);

    const result = await this.index.search(filter.search, {
      limit,
      filter: searchFilters,
      sort: ['createdAt:desc'],
    });

    return result.hits.map(this.toEvent);
  }

  async findTopIdsWithScore(
    filter: EventSearchRepositoryFilter,
  ): Promise<TEventIdWithScore[]> {
    if (!this.index) return [];

    const limit = this.getLimitFrom(filter);
    if (limit === 0) return [];

    const searchFilters = this.buildSearchFilters(filter);

    const result = await this.index.search(filter.search, {
      limit,
      filter: searchFilters,
      attributesToRetrieve: ['id', 'createdAt'],
      showRankingScore: true,
    });

    // TODO: algorithm to calculate score
    return result.hits.map((hit) => ({
      id: hit.id,
      score: hit.createdAt * (1 + (hit._rankingScore ?? 0)),
    }));
  }

  async add(event: Event) {
    if (!this.index || !this.syncEventKinds.includes(event.kind)) return;

    try {
      await this.index.addDocuments([this.toEventDocument(event)]);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async deleteMany(eventIds: string[]) {
    if (!this.index) return;

    try {
      await this.index.deleteDocuments(eventIds);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async replace(event: Event, oldEventId?: string) {
    if (!this.index) return;

    await Promise.all([
      this.add(event),
      oldEventId ? this.deleteMany([oldEventId]) : undefined,
    ]);
  }

  private buildSearchFilters(filter: EventSearchRepositoryFilter): string[] {
    const searchFilters: string[] = [
      `expiredAt IS NULL OR expiredAt >= ${getTimestampInSeconds()}`,
    ];

    if (filter.ids?.length) {
      searchFilters.push(`id IN [${filter.ids.join(', ')}]`);
    }

    if (filter.kinds?.length) {
      searchFilters.push(`kind IN [${filter.kinds.join(', ')}]`);
    }

    if (filter.since) {
      searchFilters.push(`createdAt >= ${filter.since}`);
    }

    if (filter.until) {
      searchFilters.push(`createdAt <= ${filter.until}`);
    }

    if (filter.authors?.length) {
      searchFilters.push(`author IN [${filter.authors.join(', ')}]`);
    }

    if (filter.genericTagsCollection?.length) {
      filter.genericTagsCollection.forEach((genericTags) => {
        searchFilters.push(`genericTags IN [${genericTags.join(', ')}]`);
      });
    }

    if (filter.dTagValues?.length) {
      searchFilters.push(`dTagValue IN [${filter.dTagValues.join(', ')}]`);
    }

    return searchFilters;
  }

  private getLimitFrom(
    filter: EventSearchRepositoryFilter,
    defaultLimit = 100,
  ) {
    return Math.min(isNil(filter.limit) ? defaultLimit : filter.limit, 1000);
  }

  private toEventDocument(event: Event): EventDocument {
    return {
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.createdAt,
      kind: event.kind,
      tags: event.tags,
      genericTags: event.genericTags,
      content: event.content,
      sig: event.sig,
      expiredAt: event.expiredAt,
      author: event.author,
      dTagValue: event.dTagValue,
    };
  }

  private toEvent(eventDocument: EventDocument): Event {
    const event = new Event();
    event.id = eventDocument.id;
    event.pubkey = eventDocument.pubkey;
    event.createdAt = eventDocument.createdAt;
    event.kind = eventDocument.kind;
    event.tags = eventDocument.tags;
    event.content = eventDocument.content;
    event.sig = eventDocument.sig;
    event.expiredAt = eventDocument.expiredAt;
    event.genericTags = eventDocument.genericTags;
    event.dTagValue = eventDocument.dTagValue;
    event.author = eventDocument.author;

    return event;
  }
}
