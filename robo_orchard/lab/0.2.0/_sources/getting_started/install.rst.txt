.. _getting_started_install:

Installation
======================

Prerequest
----------------
* Linux (Tested on Ubuntu 22.04)
* Python >= 3.10 (Tested on 3.10)
* torch >= 2.4.0

This project requires PyTorch version 2.4.0 or higher. Since the specific PyTorch
build (CPU, CUDA 11.x, CUDA 12.x, etc.) depends on your system, please install it
manually first by following the official instructions on the
`PyTorch website <https://pytorch.org/get-started/locally/>`_.

Install from pip
--------------------------------
The release version of this package is available on PyPI. You can install
it using pip:

.. code-block:: shell

    pip install robo_orchard_lab

Note that some features may require additional dependencies that are not
included in the base package. For example, to install the dependencies
for BIP3D algorithm, you can run:

.. code-block:: shell

    pip install robo_orchard_lab[bip3d]

If you want to install development version, please install it from source
as described below.


Install from source
--------------------------------

For the latest development version, you can clone the repository and install
it from source:

.. code-block:: shell

    cd /path/to/robo_orchard_lab
    make version  # to update the version file from git commit
    pip install .


Known Issues
--------------------------------

We have tried to make the installation process as easy as possible, but there are
some dependencies that may not available on pypi. You have to install them
manually.

For example, you have to install `pytorch3d <https://github.com/facebookresearch/pytorch3d>`_ manually because the
default pip package is not compatible with your PyTorch version.
