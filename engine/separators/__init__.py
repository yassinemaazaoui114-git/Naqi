"""The two separator networks Naqi runs (only the code needed to run them, not to train them):
  bandit_v2/              Bandit v2: speech / music / effects of film sound
  mel_band_roformer.py    Mel-Band Roformer: the voice (talking or singing) of a mix
Copied from github.com/ZFTurbo/Music-Source-Separation-Training (MIT, see LICENSE in this folder). Changes are
marked "Naqi:" in the files: no PyTorch Lightning and no librosa needed.
"""
