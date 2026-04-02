"""
Evaluate a trained PPO agent on Deep Dive Dash.

Usage:
    python ai/evaluate.py                                    # Evaluate best model
    python ai/evaluate.py --model ai/models/submarine_ppo   # Specific model
    python ai/evaluate.py --episodes 50                      # More episodes
    python ai/evaluate.py --record                           # Save action replay
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from stable_baselines3 import PPO
from submarine_env import SubmarineDashEnv


def evaluate(model_path: str, n_episodes: int = 20, record: bool = False):
    print(f"Loading model from {model_path}...")
    model = PPO.load(model_path)

    env = SubmarineDashEnv(seed=12345)
    scores = []
    distances = []
    steps_list = []
    death_causes = []
    replays = []

    for ep in range(n_episodes):
        obs, info = env.reset(seed=12345 + ep)
        episode_reward = 0
        actions = []
        done = False

        while not done:
            action, _ = model.predict(obs, deterministic=True)
            obs, reward, terminated, truncated, info = env.step(int(action))
            episode_reward += reward
            done = terminated or truncated

            if record:
                actions.append(int(action))

        score = info.get("score", 0)
        distance = info.get("distance", 0)
        step = info.get("step", 0)
        cause = info.get("deathCause", "truncated")

        scores.append(score)
        distances.append(distance)
        steps_list.append(step)
        death_causes.append(cause)

        if record:
            replays.append({
                "seed": 12345 + ep,
                "actions": actions,
                "score": score,
                "distance": distance,
            })

        print(f"  Episode {ep + 1:3d}: score={score:6d}  distance={distance:8.0f}  "
              f"steps={step:5d}  death={cause}  reward={episode_reward:.2f}")

    env.close()

    # Summary statistics
    print("\n" + "=" * 60)
    print("EVALUATION SUMMARY")
    print("=" * 60)
    print(f"  Episodes:      {n_episodes}")
    print(f"  Mean score:    {np.mean(scores):.1f} ± {np.std(scores):.1f}")
    print(f"  Median score:  {np.median(scores):.1f}")
    print(f"  Max score:     {max(scores)}")
    print(f"  Min score:     {min(scores)}")
    print(f"  Mean distance: {np.mean(distances):.0f}")
    print(f"  Mean steps:    {np.mean(steps_list):.0f}")
    print(f"  Death causes:  {dict(zip(*np.unique(death_causes, return_counts=True)))}")

    if record and replays:
        ai_dir = os.path.dirname(__file__)
        replay_path = os.path.join(ai_dir, "models", "replay.json")
        with open(replay_path, "w") as f:
            json.dump(replays, f)
        print(f"\n  Replays saved to {replay_path}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate trained Deep Dive Dash agent")
    parser.add_argument("--model", type=str, default=None, help="Path to model file")
    parser.add_argument("--episodes", type=int, default=20, help="Number of evaluation episodes")
    parser.add_argument("--record", action="store_true", help="Record action replays")
    args = parser.parse_args()

    ai_dir = os.path.dirname(__file__)

    # Find model: explicit path > best model > latest model
    if args.model:
        model_path = args.model
    else:
        best = os.path.join(ai_dir, "models", "best", "best_model")
        latest = os.path.join(ai_dir, "models", "submarine_ppo")
        if os.path.exists(best + ".zip"):
            model_path = best
        elif os.path.exists(latest + ".zip"):
            model_path = latest
        else:
            print("No trained model found. Run train.py first.")
            sys.exit(1)

    evaluate(model_path, n_episodes=args.episodes, record=args.record)


if __name__ == "__main__":
    main()
