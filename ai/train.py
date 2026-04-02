"""
Train a PPO agent to play Deep Dive Dash.

Usage:
    python ai/train.py                          # Default: 2M steps, 4 envs
    python ai/train.py --timesteps 5000000      # Custom timesteps
    python ai/train.py --n-envs 8               # More parallel environments
    python ai/train.py --resume ai/models/submarine_ppo  # Resume training
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import SubprocVecEnv
from stable_baselines3.common.callbacks import EvalCallback, CheckpointCallback
from submarine_env import make_env


def main():
    parser = argparse.ArgumentParser(description="Train PPO agent for Deep Dive Dash")
    parser.add_argument("--timesteps", type=int, default=2_000_000, help="Total training timesteps")
    parser.add_argument("--n-envs", type=int, default=4, help="Number of parallel environments")
    parser.add_argument("--resume", type=str, default=None, help="Path to model to resume training")
    parser.add_argument("--eval-freq", type=int, default=25_000, help="Evaluation frequency (steps)")
    args = parser.parse_args()

    ai_dir = os.path.dirname(__file__)
    model_dir = os.path.join(ai_dir, "models")
    log_dir = os.path.join(ai_dir, "logs")
    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(log_dir, exist_ok=True)

    # Training environments (different seeds for diversity)
    print(f"Creating {args.n_envs} parallel training environments...")
    train_env = SubprocVecEnv([make_env(seed=i * 1000) for i in range(args.n_envs)])

    # Evaluation environment (fixed seed for consistent comparison)
    eval_env = SubprocVecEnv([make_env(seed=99999)])

    # Callbacks
    eval_callback = EvalCallback(
        eval_env,
        best_model_save_path=os.path.join(model_dir, "best"),
        log_path=log_dir,
        eval_freq=args.eval_freq,
        n_eval_episodes=5,
        deterministic=True,
    )
    checkpoint_callback = CheckpointCallback(
        save_freq=50_000,
        save_path=os.path.join(model_dir, "checkpoints"),
        name_prefix="submarine_ppo",
    )

    if args.resume:
        print(f"Resuming training from {args.resume}")
        model = PPO.load(args.resume, env=train_env)
    else:
        print("Creating new PPO model...")
        model = PPO(
            "MlpPolicy",
            train_env,
            learning_rate=3e-4,
            n_steps=2048,
            batch_size=64,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.01,
            vf_coef=0.5,
            max_grad_norm=0.5,
            verbose=1,
            tensorboard_log=log_dir,
            policy_kwargs=dict(net_arch=[256, 256]),
        )

    print(f"Training for {args.timesteps:,} timesteps...")
    model.learn(
        total_timesteps=args.timesteps,
        callback=[eval_callback, checkpoint_callback],
        progress_bar=True,
    )

    save_path = os.path.join(model_dir, "submarine_ppo")
    model.save(save_path)
    print(f"Model saved to {save_path}")

    train_env.close()
    eval_env.close()


if __name__ == "__main__":
    main()
