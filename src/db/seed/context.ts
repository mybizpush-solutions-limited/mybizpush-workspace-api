import type { Department, Label, Product, Project, Task, Team, User } from "../../models";

export interface SeededTask {
  task: Task;
  project: Project;
  assigneeIds: string[];
}

export class SeedContext {
  readonly users = new Map<string, User>();
  readonly departments = new Map<string, Department>();
  readonly teams = new Map<string, Team>();
  readonly products = new Map<string, Product>();
  readonly projects = new Map<string, Project>();
  readonly labels = new Map<string, Label>();
  readonly tasks: SeededTask[] = [];

  user(key: string): User {
    const user = this.users.get(key);
    if (!user) throw new Error(`Seed references unknown person "${key}"`);
    return user;
  }

  id(key: string): string {
    return this.user(key).id;
  }

  ids(keys: string[]): string[] {
    return keys.map((k) => this.id(k));
  }

  department(slug: string): Department {
    return required(this.departments.get(slug), `department "${slug}"`);
  }

  team(slug: string): Team {
    return required(this.teams.get(slug), `team "${slug}"`);
  }

  product(slug: string): Product {
    return required(this.products.get(slug), `product "${slug}"`);
  }

  project(name: string): Project {
    return required(this.projects.get(name), `project "${name}"`);
  }
}

function required<T>(value: T | undefined, what: string): T {
  if (!value) throw new Error(`Seed references unknown ${what}`);
  return value;
}

export async function setAssociation(instance: object, accessor: string, ids: string[]): Promise<void> {
  await (instance as Record<string, (ids: string[]) => Promise<void>>)[accessor]!(ids);
}
