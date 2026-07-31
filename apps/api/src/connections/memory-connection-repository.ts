import type {
  ConnectionRepository,
  StoredConnectionProfile,
} from './connection-types.js'

export class MemoryConnectionRepository implements ConnectionRepository {
  private readonly profiles = new Map<string, StoredConnectionProfile>()

  async create(profile: StoredConnectionProfile): Promise<void> {
    this.profiles.set(profile.id, structuredClone(profile))
  }

  async findById(id: string): Promise<StoredConnectionProfile | undefined> {
    const profile = this.profiles.get(id)
    return profile ? structuredClone(profile) : undefined
  }

  async list(): Promise<StoredConnectionProfile[]> {
    return [...this.profiles.values()].map((profile) => structuredClone(profile))
  }

  getStored(id: string): StoredConnectionProfile | undefined {
    const profile = this.profiles.get(id)
    return profile ? structuredClone(profile) : undefined
  }
}
