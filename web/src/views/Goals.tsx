import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import type { Goal } from '../../../shared/types.ts';
import { useGoals } from '../api.ts';
import { Orb } from '../components/Orb.tsx';
import { GoalRow } from '../components/rows.tsx';
import { Loading, Seg } from '../components/ui.tsx';
import { hueStyle, plural } from '../lib.ts';
import { useApp } from '../state.tsx';

type Filter = 'active' | 'done' | 'all';

export function Goals() {
  const [filter, setFilter] = useState<Filter>('active');
  const { data: goals } = useGoals('all');
  const { spheres, openSheet, ask, agentName } = useApp();
  if (!goals) return <Loading />;

  const shown = goals.filter((g) => (filter === 'all' ? true : filter === 'done' ? g.status === 'done' : g.status === 'active'));
  const groups = spheres
    .map((s) => ({ sphere: s, goals: shown.filter((g: Goal) => g.sphereId === s.id) }))
    .filter((g) => g.goals.length > 0);
  const active = goals.filter((g) => g.status === 'active').length;
  const reached = goals.filter((g) => g.status === 'done').length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Goals</h1>
          <p className="page-sub">
            {goals.length === 0 ? 'The outcomes you are working toward, across every sphere.' : `${plural(active, 'goal')} in motion, ${reached} reached.`}
          </p>
        </div>
        <div className="row-wrap">
          <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'done', label: 'Reached' }, { value: 'all', label: 'All' }]} />
          <button type="button" className="btn btn-primary" onClick={() => openSheet({ kind: 'new-goal' })} disabled={spheres.length === 0}>
            <Plus size={15} /> New goal
          </button>
        </div>
      </header>

      {groups.length === 0 ? (
        <div className="empty-block">
          <h3>{filter === 'done' ? 'Nothing reached yet' : goals.length === 0 ? 'No goals yet' : 'Nothing to show'}</h3>
          <p style={{ maxWidth: '44ch' }}>
            {filter === 'done' ? 'Goals you mark as reached collect here.' : 'A goal is an outcome inside a sphere. Break it into steps, or let a number you track drive its progress.'}
          </p>
          {filter !== 'done' && (
            <div className="row-wrap" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => openSheet({ kind: 'new-goal' })} disabled={spheres.length === 0}>
                Set a goal
              </button>
              <button type="button" className="btn" onClick={() => ask('I want to set a new goal. Help me think it through, one question at a time.')}>
                <span className="btn-text">Think it through with {agentName}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="goal-groups">
          {groups.map(({ sphere, goals: list }) => (
            <section key={sphere.id} className="card tint" style={{ ...hueStyle(sphere.hue), paddingBottom: 6 }}>
              <Link href={`/spheres/${sphere.id}`} className="group-head">
                <Orb hue={sphere.hue} icon={sphere.icon} size={26} />
                <h3>{sphere.name}</h3>
              </Link>
              {list.map((g) => (
                <GoalRow key={g.id} goal={g} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
